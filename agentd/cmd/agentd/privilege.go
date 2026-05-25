//go:build linux
// +build linux

package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// dropPrivileges switches from root to the configured unprivileged user.
// Must be called after all root-only setup (PID file, port binding, etc.)
// but before serving agent requests.
func dropPrivileges(username string) error {
	if username == "" || username == "root" {
		slog.Warn("running as root — no privilege drop (set security.run_as_user to a non-root user)")
		return nil
	}

	// Resolve user via getent (works with local users, LDAP, etc.)
	cmd := exec.Command("getent", "passwd", username)
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("user %q not found: %w", username, err)
	}
	fields := strings.Split(strings.TrimSpace(string(out)), ":")
	if len(fields) < 7 {
		return fmt.Errorf("unexpected getent output for user %q", username)
	}

	uid, err := strconv.Atoi(fields[2])
	if err != nil || uid <= 0 {
		return fmt.Errorf("invalid uid for user %q: %s", username, fields[2])
	}
	gid, err := strconv.Atoi(fields[3])
	if err != nil || gid <= 0 {
		return fmt.Errorf("invalid gid for user %q: %s", username, fields[3])
	}
	homeDir := fields[5]
	shell := fields[6]

	slog.Info("dropping privileges",
		"user", username, "uid", uid, "gid", gid, "home", homeDir,
	)

	// Set home and shell env for the target user
	os.Setenv("HOME", homeDir)
	os.Setenv("SHELL", shell)
	os.Setenv("USER", username)
	os.Setenv("LOGNAME", username)

	// Set supplementary groups
	if err := syscall.Setgroups([]int{gid}); err != nil {
		return fmt.Errorf("setgroups: %w", err)
	}
	// Set GID then UID — order matters, once UID drops to non-root we can't change groups
	if err := syscall.Setgid(gid); err != nil {
		return fmt.Errorf("setgid %d: %w", gid, err)
	}
	if err := syscall.Setuid(uid); err != nil {
		return fmt.Errorf("setuid %d: %w", uid, err)
	}

	// Verify we can't go back
	if os.Getuid() == 0 {
		return fmt.Errorf("still root after drop — aborting")
	}

	slog.Info("privileges dropped", "uid", os.Getuid(), "gid", os.Getgid())
	return nil
}

// nodeIdentity loads or generates a persistent node ID.
func nodeIdentity(idFile string) (string, error) {
	if idFile == "" {
		idFile = "/var/run/agentd.node_id"
	}
	dir := filepath.Dir(idFile)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create dir for node id: %w", err)
	}

	// Try to read existing ID
	if data, err := os.ReadFile(idFile); err == nil {
		id := strings.TrimSpace(string(data))
		if id != "" {
			slog.Info("loaded existing node id", "node_id", id, "file", idFile)
			return id, nil
		}
	}

	// Generate new UUID-based ID
	id := generateNodeID()
	if err := os.WriteFile(idFile, []byte(id+"\n"), 0o644); err != nil {
		return "", fmt.Errorf("write node id file: %w", err)
	}
	slog.Info("generated new node id", "node_id", id, "file", idFile)
	return id, nil
}

func generateNodeID() string {
	// Simple UUID v4-like generation using hostname + time + random
	hostname, _ := os.Hostname()
	return fmt.Sprintf("node-%s-%d", hostname, time.Now().UnixNano())
}

// metricsCollector collects system metrics and writes them to a JSON file
// that the main process can read after dropping privileges.
type metricsCollector struct {
	nodeID     string
	outputPath string
	interval   time.Duration
	stopCh     chan struct{}
}

func startMetricsCollector(nodeID, outputPath string, interval time.Duration) *metricsCollector {
	mc := &metricsCollector{
		nodeID:     nodeID,
		outputPath: outputPath,
		interval:   interval,
		stopCh:     make(chan struct{}),
	}
	go mc.run()
	return mc
}

func (mc *metricsCollector) Stop() {
	close(mc.stopCh)
}

func (mc *metricsCollector) run() {
	ticker := time.NewTicker(mc.interval)
	defer ticker.Stop()
	for {
		select {
		case <-mc.stopCh:
			return
		case <-ticker.C:
			mc.collect()
		}
	}
}

func (mc *metricsCollector) collect() {
	metrics := map[string]any{
		"node_id":   mc.nodeID,
		"timestamp": time.Now().Unix(),
	}

	// CPU: 1-minute loadavg / num CPUs
	if loadData, err := os.ReadFile("/proc/loadavg"); err == nil {
		fields := strings.Fields(string(loadData))
		if len(fields) >= 1 {
			if load, parseErr := strconv.ParseFloat(fields[0], 64); parseErr == nil {
				numCPU := float64(getNumCPU())
				if numCPU > 0 {
					metrics["cpu_usage"] = load / numCPU
				}
			}
		}
	}

	// Memory: MemAvailable / MemTotal
	if memData, err := os.ReadFile("/proc/meminfo"); err == nil {
		var memTotal, memAvailable float64
		for _, line := range strings.Split(string(memData), "\n") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				val, _ := strconv.ParseFloat(fields[1], 64)
				switch fields[0] {
				case "MemTotal:":
					memTotal = val
				case "MemAvailable:":
					memAvailable = val
				}
			}
		}
		if memTotal > 0 {
			metrics["mem_avail"] = memAvailable / memTotal
		}
	}

	// Disk: sandbox base directory
	var stat syscall.Statfs_t
	if err := syscall.Statfs("/tmp/agentd", &stat); err == nil {
		total := float64(stat.Blocks) * float64(stat.Bsize)
		avail := float64(stat.Bavail) * float64(stat.Bsize)
		if total > 0 {
			metrics["disk_avail"] = avail / total
		}
	}

	data, _ := json.Marshal(metrics)
	os.WriteFile(mc.outputPath, data, 0o644)
}

func getNumCPU() int {
	if n := os.Getenv("GOMAXPROCS"); n != "" {
		if v, err := strconv.Atoi(n); err == nil && v > 0 {
			return v
		}
	}
	out, err := exec.Command("nproc").Output()
	if err == nil {
		if v, err := strconv.Atoi(strings.TrimSpace(string(out))); err == nil && v > 0 {
			return v
		}
	}
	return 1
}

// readMetrics reads the latest metrics written by the collector.
func readMetrics(outputPath string) (map[string]any, error) {
	data, err := os.ReadFile(outputPath)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return m, nil
}
