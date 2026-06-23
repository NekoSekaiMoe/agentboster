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
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/config"
	"github.com/clawless/agentd/internal/metrics"
)

const (
	// pidFilePath is the fallback PID record read when the socket lock is
	// held by a stale (crashed) instance. Format: "<pid>\n<unix_ts>\n".
	pidFilePath = "/var/run/agentd.pid"
	// socketLockPath is the primary mutex. Binding a Unix domain socket at
	// this path is an atomic OS-level operation, immune to PID reuse and
	// TOCTOU races that plague pure PID-file schemes.
	socketLockPath = "/var/run/agentd.sock"
)

// AcquireSingleton ensures only one Agent Daemon instance runs on this machine.
//
// Three layers, in order of authority:
//  1. Socket lock at socketLockPath — OS-level atomic mutex. Survives PID
//     reuse and TOCTOU; the kernel guarantees only one process can hold the
//     listener. Closing the listener (clean shutdown) removes the socket file.
//  2. PID file at pidFilePath — fallback. If the socket is held, we read the
//     PID, probe /proc/<pid>/exe and /proc/<pid>/cmdline to confirm the
//     holder is really an agentd, and only then refuse. If the recorded PID
//     is dead or belongs to an unrelated process, the socket file is treated
//     as stale (left behind by kill -9 / OOM / power loss) and cleaned up.
//  3. CheckPortAvailable (called separately from main.go) — edge-case
//     backstop for a rogue instance whose socket file was deleted out from
//     under it but is still listening on server.listen.
//
// Returns a cleanup function that closes the listener and removes the PID
// file on shutdown.
func AcquireSingleton() (func(), error) {
	return acquireSingletonAt(socketLockPath, pidFilePath)
}

// acquireSingletonAt is the testable core of AcquireSingleton. It takes
// explicit paths so tests can use t.TempDir() without touching /var/run.
func acquireSingletonAt(sockPath, pidPath string) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(sockPath), 0o755); err != nil {
		return nil, fmt.Errorf("create singleton dir: %w", err)
	}

	// Layer 1: socket lock (OS atomic mutex).
	listener, err := tryAcquireSocketLock(sockPath)
	if err == nil {
		return finishAcquire(listener, pidPath)
	}
	if !isAddrInUseError(err) {
		return nil, fmt.Errorf("acquire socket lock: %w", err)
	}

	// Layer 2: socket is held — consult PID file to decide.
	pid, ok := readPidFromFile(pidPath)
	if !ok {
		return nil, fmt.Errorf(
			"Agent Daemon already running (socket %s held, no pid file)", sockPath)
	}

	alive, isAgentd := probeProcess(pid)
	switch {
	case alive && isAgentd:
		return nil, fmt.Errorf("Agent Daemon already running (PID: %d)", pid)
	case alive && !isAgentd:
		// Socket held but PID file points to a non-agentd process. The
		// socket itself is evidence a holder exists; we can't trust the
		// PID file anymore, so conservatively refuse rather than race.
		return nil, fmt.Errorf(
			"Agent Daemon already running (socket %s held, pid file stale, pid=%d)",
			sockPath, pid)
	}

	// Layer 3: recorded PID is dead — clean stale artifacts and retry.
	slog.Warn("cleaning stale singleton artifacts",
		"socket", sockPath, "pid_file", pidPath, "stale_pid", pid)
	cleanupStaleArtifacts(sockPath, pidPath)

	listener, err = tryAcquireSocketLock(sockPath)
	if err != nil {
		return nil, fmt.Errorf("re-acquire socket lock after cleanup: %w", err)
	}
	return finishAcquire(listener, pidPath)
}

// tryAcquireSocketLock binds a Unix domain socket at path. The bind is the
// mutex primitive — only one process can succeed. We deliberately do NOT
// pre-remove an existing file; that would race a live instance's lock.
// EADDRINUSE means either a live holder or a stale leftover; the caller
// uses the PID file to disambiguate.
func tryAcquireSocketLock(path string) (net.Listener, error) {
	return net.Listen("unix", path)
}

// isAddrInUseError reports whether err is EADDRINUSE on a unix socket bind.
func isAddrInUseError(err error) bool {
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return errors.Is(opErr.Err, syscall.EADDRINUSE)
	}
	return errors.Is(err, syscall.EADDRINUSE)
}

// readPidFromFile parses "<pid>\n<ts>\n" and returns the PID. Returns
// (0, false) on missing file or malformed content.
func readPidFromFile(path string) (int, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) == 0 {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(lines[0]))
	if err != nil || pid <= 0 {
		return 0, false
	}
	return pid, true
}

// probeProcess checks liveness and identity of a PID.
//
// Returns (alive, isAgentd). isAgentd is only meaningful when alive is true.
// Identity requires BOTH /proc/<pid>/exe path matching the current binary
// AND /proc/<pid>/cmdline basename starting with "agentd".
func probeProcess(pid int) (alive bool, isAgentd bool) {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false, false
	}
	// Signal(0) does not deliver a signal; it just probes liveness.
	if sigErr := proc.Signal(syscall.Signal(0)); sigErr != nil {
		if errors.Is(sigErr, syscall.EPERM) {
			// Process exists but we can't signal it (different user).
			// Reading /proc/<pid>/{exe,cmdline} will likely also fail,
			// so treat as "alive but identity unconfirmable".
			return true, false
		}
		// ESRCH or anything else → process is gone.
		return false, false
	}

	// Alive. Confirm identity via exe path AND cmdline basename.
	exeMatch := checkExePath(pid)
	cmdMatch := checkCmdline(pid)
	return true, exeMatch && cmdMatch
}

// checkExePath compares the target process's executable path (resolved
// through symlinks) against the current process's own executable. Returns
// false if either path can't be resolved — forcing the caller into the
// conservative "not confirmed" branch.
func checkExePath(pid int) bool {
	selfExe, err := os.Executable()
	if err != nil {
		return false
	}
	selfExe, err = filepath.EvalSymlinks(selfExe)
	if err != nil {
		return false
	}
	target, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil {
		return false
	}
	target, err = filepath.EvalSymlinks(target)
	if err != nil {
		// Readlink on /proc/<pid>/exe already yields the canonical path;
		// EvalSymlinks can still fail if the binary was deleted. Accept
		// the raw readlink result in that case.
		target, _ = os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	}
	return selfExe == target
}

// checkCmdline reads /proc/<pid>/cmdline and reports whether argv[0]'s
// basename is exactly "agentd" or starts with "agentd" (covers test
// binaries like "agentd.test" and versioned names like "agentd-v2").
func checkCmdline(pid int) bool {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return false
	}
	// cmdline is null-separated; trim trailing NULs before split.
	fields := strings.Split(strings.TrimRight(string(data), "\x00"), "\x00")
	if len(fields) == 0 || fields[0] == "" {
		return false
	}
	base := filepath.Base(fields[0])
	return base == "agentd" || strings.HasPrefix(base, "agentd")
}

// cleanupStaleArtifacts removes leftover socket and PID files. Both calls
// ignore "not exist" errors — they may have already been cleaned.
func cleanupStaleArtifacts(sockPath, pidPath string) {
	if err := os.Remove(sockPath); err != nil && !os.IsNotExist(err) {
		slog.Warn("failed to remove stale socket", "path", sockPath, "error", err)
	}
	if err := os.Remove(pidPath); err != nil && !os.IsNotExist(err) {
		slog.Warn("failed to remove stale pid file", "path", pidPath, "error", err)
	}
}

// finishAcquire completes the lock acquisition: writes the PID file
// atomically (tmp + rename to avoid TOCTOU on the PID file itself) and
// returns a cleanup function.
func finishAcquire(listener net.Listener, pidPath string) (func(), error) {
	pid := os.Getpid()
	content := fmt.Sprintf("%d\n%d\n", pid, time.Now().Unix())

	// Atomic write: write tmp file in the same dir, then rename.
	tmpPath := pidPath + ".tmp"
	if err := os.WriteFile(tmpPath, []byte(content), 0o644); err != nil {
		// Listener is already held; close it to release the socket lock
		// before returning the error so we don't leak the lock.
		_ = listener.Close()
		return nil, fmt.Errorf("write pid tmp file: %w", err)
	}
	if err := os.Rename(tmpPath, pidPath); err != nil {
		_ = os.Remove(tmpPath)
		_ = listener.Close()
		return nil, fmt.Errorf("rename pid file: %w", err)
	}

	slog.Info("singleton lock acquired",
		"socket", socketLockPathForLog(listener), "pid_file", pidPath, "pid", pid)

	return func() {
		if err := listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			slog.Warn("failed to close singleton listener", "error", err)
		}
		if err := os.Remove(pidPath); err != nil && !os.IsNotExist(err) {
			slog.Warn("failed to remove pid file", "path", pidPath, "error", err)
		} else {
			slog.Info("singleton lock released", "pid_file", pidPath)
		}
	}, nil
}

// socketLockPathForLog tries to extract the socket path from the listener
// for logging; falls back to a placeholder if Addr parsing fails.
func socketLockPathForLog(listener net.Listener) string {
	if ta, ok := listener.Addr().(*net.UnixAddr); ok {
		return ta.Name
	}
	return "<unknown>"
}

// CheckPortAvailable tries to bind a TCP listener at the given address and
// closes it immediately. It's a fail-fast diagnostic for the edge case where
// the socket lock file was deleted but a rogue instance is still listening
// on server.listen. Called from main.go after AcquireSingleton succeeds.
func CheckPortAvailable(listen string) error {
	l, err := net.Listen("tcp", listen)
	if err != nil {
		return fmt.Errorf("listen %s already in use (another instance or process): %w", listen, err)
	}
	return l.Close()
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

// ActiveCountsFn returns the current active task/sandbox counts for
// the heartbeat payload. Set by main.go after the agent manager is
// constructed. P3.1: previously the heartbeat always sent 0/0.
type ActiveCountsFn func() (activeTasks, activeSandboxes int)

// StartHeartbeat starts a background heartbeat goroutine.
//
// P3.1: the optional countsFn lets us forward real active-task and
// active-sandbox counts so the web layer's selectBestNode can use
// them in its load score.
func StartHeartbeat(client *clawless.Client, nodeID string, interval time.Duration, metricsPath string, countsFn ActiveCountsFn) {
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

			activeTasks, activeSandboxes := 0, 0
			if countsFn != nil {
				activeTasks, activeSandboxes = countsFn()
			}

			// P2.3: also forward the per-agent sandbox summary if present.
			perAgent := map[string]int{}
			if arr, ok := m["sandbox_count_per_agent"].(map[string]int); ok {
				perAgent = arr
			}

			// P3.3: forward per-sandbox cgroup v2 samples when present.
			// Web side aggregates into per-node totals for NodeSelector.
			var cgroupStats any
			if cs, ok := m["cgroup_stats"]; ok {
				cgroupStats = cs
			}

			reqBody := map[string]any{
				"node_id":          nodeID,
				"cpu_model":        m["cpu_model"],
				"cpu_usage":        m["cpu_usage"],
				"mem_avail":        m["mem_avail"],
				"disk_avail":       m["disk_avail"],
				"active_tasks":     activeTasks,
				"active_sandboxes": activeSandboxes,
				"per_agent":        perAgent,
				"cgroup_stats":     cgroupStats,
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
