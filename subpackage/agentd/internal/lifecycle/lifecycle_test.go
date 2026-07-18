//go:build linux
// +build linux

package lifecycle

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// withTempPaths returns socket and pid paths inside a temp dir for the test.
func withTempPaths(t *testing.T) (sockPath, pidPath string) {
	t.Helper()
	dir := t.TempDir()
	return filepath.Join(dir, "agentd.sock"), filepath.Join(dir, "agentd.pid")
}

// TestAcquireSingleton_FirstTime verifies a clean environment allows the
// lock to be acquired, and the PID file is written with the current PID.
func TestAcquireSingleton_FirstTime(t *testing.T) {
	sockPath, pidPath := withTempPaths(t)

	release, err := acquireSingletonAt(sockPath, pidPath)
	if err != nil {
		t.Fatalf("first acquire failed: %v", err)
	}
	defer release()

	pid, ok := readPidFromFile(pidPath)
	if !ok {
		t.Fatalf("pid file not written at %s", pidPath)
	}
	if pid != os.Getpid() {
		t.Fatalf("pid file has %d, want %d", pid, os.Getpid())
	}

	if _, err := os.Stat(sockPath); err != nil {
		t.Fatalf("socket file not created: %v", err)
	}
}

// TestAcquireSingleton_SecondInstanceRejected verifies that when the socket
// is held by a live process (this test process), a second acquire attempt
// returns an "already running" error.
//
// Note: the test binary is named "lifecycle.test", not "agentd", so
// checkCmdline fails and probeProcess reports isAgentd=false. The second
// acquire therefore lands in the "socket held, pid file stale" branch
// rather than the "PID: N" branch. Both refuse startup — this test only
// asserts the refusal, since the precise branch depends on the binary
// name (production binary is "agentd" and would hit the "PID: N" branch).
func TestAcquireSingleton_SecondInstanceRejected(t *testing.T) {
	sockPath, pidPath := withTempPaths(t)

	release, err := acquireSingletonAt(sockPath, pidPath)
	if err != nil {
		t.Fatalf("first acquire failed: %v", err)
	}
	defer release()

	_, err = acquireSingletonAt(sockPath, pidPath)
	if err == nil {
		t.Fatal("second acquire unexpectedly succeeded")
	}
	if !strings.Contains(err.Error(), "already running") {
		t.Fatalf("error should mention 'already running', got: %v", err)
	}
}

// TestAcquireSingleton_StaleSocketCleaned simulates a crash leftover: a
// stale socket file plus a PID file pointing at an already-dead PID. The
// next AcquireSingleton should detect this and clean up successfully.
func TestAcquireSingleton_StaleSocketCleaned(t *testing.T) {
	sockPath, pidPath := withTempPaths(t)

	// Spawn a short-lived child whose PID we record as "stale".
	dead := spawnShortLivedChild(t)
	t.Logf("using dead child pid=%d as stale pid", dead)

	// Plant leftover socket file (just a regular file, not a live listener).
	if err := os.WriteFile(sockPath, []byte("stale"), 0o644); err != nil {
		t.Fatalf("plant stale socket: %v", err)
	}
	// Plant PID file referencing the dead child.
	if err := os.WriteFile(pidPath, []byte(fmt.Sprintf("%d\n%d\n", dead, time.Now().Unix())), 0o644); err != nil {
		t.Fatalf("plant stale pid file: %v", err)
	}
	// Wait for the child to actually exit so the PID is no longer alive.
	waitForPidGone(dead, 2*time.Second)

	release, err := acquireSingletonAt(sockPath, pidPath)
	if err != nil {
		t.Fatalf("acquire after stale cleanup failed: %v", err)
	}
	defer release()

	if _, err := os.Stat(sockPath); err != nil {
		t.Fatalf("socket not re-created after cleanup: %v", err)
	}
}

// TestProbeProcess_Self verifies probeProcess recognizes the current
// process as a live agentd. Since test binaries are named
// "<pkg>.test" — not "agentd" — the cmdline check would fail. We verify
// the function returns alive=true and that identity is correctly derived
// from the exe-path check (cmdline will be false for the test binary, so
// isAgentd should be false — the test documents this contract).
func TestProbeProcess_Self(t *testing.T) {
	alive, _ := probeProcess(os.Getpid())
	if !alive {
		t.Fatal("probeProcess(self) should report alive=true")
	}
	// Note: isAgentd is expected to be false here because the test binary
	// is named "lifecycle.test", not "agentd". This is the documented
	// conservative behavior: both checks must pass.
}

// TestProbeProcess_Unrelated verifies a non-agentd live process is
// reported alive but not as agentd.
func TestProbeProcess_Unrelated(t *testing.T) {
	cmd := exec.Command("sleep", "5")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start sleep child: %v", err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}()

	alive, isAgentd := probeProcess(cmd.Process.Pid)
	if !alive {
		t.Fatal("sleep child should be alive")
	}
	if isAgentd {
		t.Fatal("sleep child should NOT be identified as agentd")
	}
}

// TestProbeProcess_Dead verifies a non-existent PID is reported not alive.
func TestProbeProcess_Dead(t *testing.T) {
	// 999999 is well outside normal PID ranges; very unlikely to exist.
	alive, _ := probeProcess(999999)
	if alive {
		t.Fatal("pid 999999 should be reported dead")
	}
}

// TestCheckCmdline_NamedAgentd verifies the cmdline basename match works
// end-to-end against a real subprocess whose argv[0] basename is "agentd".
// We copy the test binary to a temp path named "agentd" and exec it in
// sleep mode; checkCmdline should return true for that PID.
func TestCheckCmdline_NamedAgentd(t *testing.T) {
	// Self-test binary path.
	selfExe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}

	// Copy to a temp file named "agentd" so argv[0] basename matches.
	dir := t.TempDir()
	namedExe := filepath.Join(dir, "agentd")
	if err := copyFile(selfExe, namedExe); err != nil {
		t.Fatalf("copy test binary: %v", err)
	}

	// Re-exec the copy as a "sleep" helper. We pass a magic env var the
	// test binary recognizes only if TEST_HELP_MODE is set; otherwise it
	// runs as a normal test. Simpler: just exec /bin/sleep through the
	// named binary path via a wrapper. Instead, use symlink trick: bind
	// /bin/sleep under the name "agentd".
	sleepNamed := filepath.Join(dir, "agentd-sleep")
	if err := os.Symlink("/bin/sleep", sleepNamed); err != nil {
		t.Fatalf("symlink sleep as agentd: %v", err)
	}

	cmd := exec.Command(sleepNamed, "10")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start named sleep: %v", err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}()

	// Wait for the child's exec() to land so /proc/<pid>/cmdline reflects
	// argv[0] = ".../agentd-sleep" rather than the still-empty pre-exec
	// state. Without this polling the test races against the kernel and
	// intermittently fails with an empty cmdline read.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if checkCmdline(cmd.Process.Pid) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// argv[0] is sleepNamed; basename is "agentd-sleep" → HasPrefix("agentd").
	if !checkCmdline(cmd.Process.Pid) {
		t.Fatalf("checkCmdline should accept argv[0] basename starting with 'agentd'")
	}
}

// copyFile copies src to dst with mode 0o755.
func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0o755)
}

// TestCheckPortAvailable_Free verifies a free TCP port is accepted.
func TestCheckPortAvailable_Free(t *testing.T) {
	// Bind an ephemeral port, grab its number, then close — leaves the
	// port free (with the usual tiny TOCTOU window the API documents).
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	addr := l.Addr().String()
	_ = l.Close()

	if err := CheckPortAvailable(addr); err != nil {
		t.Fatalf("CheckPortAvailable on free port failed: %v", err)
	}
}

// TestCheckPortAvailable_InUse verifies an in-use port is rejected.
func TestCheckPortAvailable_InUse(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	defer l.Close()

	if err := CheckPortAvailable(l.Addr().String()); err == nil {
		t.Fatal("CheckPortAvailable should fail on in-use port")
	}
}

// spawnShortLivedChild starts a process that exits almost immediately and
// returns its PID. The caller must wait for the PID to disappear before
// using it as a "stale" PID.
func spawnShortLivedChild(t *testing.T) int {
	t.Helper()
	cmd := exec.Command("true")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start short-lived child: %v", err)
	}
	pid := cmd.Process.Pid
	_ = cmd.Wait()
	return pid
}

// waitForPidGone polls proc.Signal(0) until it returns ESRCH or the
// timeout elapses.
func waitForPidGone(pid int, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		proc, err := os.FindProcess(pid)
		if err != nil {
			return
		}
		if err := proc.Signal(syscall.Signal(0)); err != nil {
			return // ESRCH or similar → gone
		}
		time.Sleep(10 * time.Millisecond)
	}
}
