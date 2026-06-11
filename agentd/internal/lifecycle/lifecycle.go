//go:build linux
// +build linux

package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/config"
	"github.com/clawless/agentd/internal/metrics"
)

// AcquireSingleton ensures only one Agent Daemon instance runs on this machine.
// Returns a cleanup function that removes the PID file on shutdown.
func AcquireSingleton() (func(), error) {
	const pidFile = "/var/run/agentd.pid"

	if err := os.MkdirAll("/var/run", 0o755); err != nil {
		return nil, fmt.Errorf("create /var/run: %w", err)
	}

	if data, err := os.ReadFile(pidFile); err == nil {
		lines := strings.Split(strings.TrimSpace(string(data)), "\n")
		if len(lines) > 0 {
			if pid, parseErr := strconv.Atoi(lines[0]); parseErr == nil && pid > 0 {
				if proc, findErr := os.FindProcess(pid); findErr == nil {
					err := proc.Signal(syscall.Signal(0))
					if err == nil {
						return nil, fmt.Errorf("Agent Daemon already running (PID: %d)", pid)
					}
					var errno syscall.Errno
					if errors.As(err, &errno) && errno == syscall.EPERM {
						return nil, fmt.Errorf("Agent Daemon already running (PID: %d, different user)", pid)
					}
				}
			}
		}
	}

	pid := os.Getpid()
	content := fmt.Sprintf("%d\n%d\n", pid, time.Now().Unix())
	if err := os.WriteFile(pidFile, []byte(content), 0o644); err != nil {
		return nil, fmt.Errorf("write pid file: %w", err)
	}

	slog.Info("singleton lock acquired", "pid_file", pidFile, "pid", pid)

	return func() {
		if err := os.Remove(pidFile); err != nil && !os.IsNotExist(err) {
			slog.Warn("failed to remove pid file", "path", pidFile, "error", err)
		} else {
			slog.Info("singleton lock released", "pid_file", pidFile)
		}
	}, nil
}

// RegisterNode registers this node with the ClawLess server.
func RegisterNode(client *clawless.Client, nodeID string, cfg *config.Config, version string) {
	reqBody := map[string]any{
		"node_id":   nodeID,
		"ip":        getNodeIP(),
		"port":      getListenPort(cfg.Server.Listen),
		"sandboxes": []string{"docker", "docker-strict", "lxc"},
		"version":   version,
	}

	go func() {
		for attempt := 1; attempt <= 5; attempt++ {
			var resp struct {
				NodeID   string `json:"node_id"`
				Interval int    `json:"interval"`
			}
			err := client.PostJSON(context.Background(), "/api/agentd/v1/nodes/register", reqBody, &resp)
			if err == nil {
				slog.Info("node registered", "node_id", resp.NodeID, "interval", resp.Interval)
				return
			}
			slog.Warn("node register failed", "attempt", attempt, "error", err)
			time.Sleep(time.Duration(attempt) * 3 * time.Second)
		}
		slog.Error("node register failed after 5 attempts")
	}()
}

// StartHeartbeat starts a background heartbeat goroutine.
func StartHeartbeat(client *clawless.Client, nodeID string, interval time.Duration, metricsPath string) {
	if interval <= 0 {
		interval = 30 * time.Second
	}

	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			<-ticker.C
			m, err := metrics.Read(metricsPath)
			if err != nil {
				slog.Warn("heartbeat: failed to read metrics", "error", err)
				continue
			}

			reqBody := map[string]any{
				"node_id":          nodeID,
				"cpu_model":        m["cpu_model"],
				"cpu_usage":        m["cpu_usage"],
				"mem_avail":        m["mem_avail"],
				"disk_avail":       m["disk_avail"],
				"active_tasks":     0,
				"active_sandboxes": 0,
				"timestamp":        time.Now().Unix(),
			}

			var resp struct {
				Accepted bool `json:"accepted"`
			}
			if err := client.PostJSON(context.Background(), "/api/agentd/v1/nodes/heartbeat", reqBody, &resp); err != nil {
				slog.Warn("heartbeat failed", "error", err)
			}
		}
	}()
}

// ListenAndServe starts the HTTP server (TLS or plain).
func ListenAndServe(srv *http.Server) error {
	if srv.TLSConfig != nil {
		return srv.ListenAndServeTLS("", "")
	}
	slog.Warn("running without TLS — not recommended for production")
	return srv.ListenAndServe()
}

func getNodeIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "127.0.0.1"
	}
	for _, addr := range addrs {
		if ipNet, ok := addr.(*net.IPNet); ok && !ipNet.IP.IsLoopback() {
			if ipNet.IP.To4() != nil {
				return ipNet.IP.String()
			}
		}
	}
	return "127.0.0.1"
}

func getListenPort(listen string) int {
	_, portStr, err := net.SplitHostPort(listen)
	if err != nil {
		return 18732
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return 18732
	}
	return port
}
