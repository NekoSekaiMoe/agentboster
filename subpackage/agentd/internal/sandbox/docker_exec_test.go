//go:build linux
// +build linux

package sandbox

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestDockerProvider_ExecSeparatesStdoutAndStderr is the P8 integration
// test. Before P8, all three providers used CombinedOutput and then
// copied the merged buffer into BOTH Stdout and Stderr on failure, so
// callers could not tell a real error message from normal output. This
// test drives DockerProvider.Exec through a fake `docker` binary that
// writes distinguishable content to each stream and exits non-zero, then
// asserts the provider kept the streams apart AND populated result.Err.
func TestDockerProvider_ExecSeparatesStdoutAndStderr(t *testing.T) {
	dir := t.TempDir()
	fakeDocker := filepath.Join(dir, "docker")

	// Fake docker: respond to `run` (sandbox create) with a container
	// id printed to stdout, and to `exec` by writing a known marker to
	// stdout, a different marker to stderr, and exiting 3. The provider's
	// Exec sets a 30s timeout and captures both streams via separate
	// pipes — we verify the streams didn't get crossed.
	script := `#!/bin/sh
case "$1" in
  run)
    echo "fake-container-id-for-exec-test"
    ;;
  exec)
    echo "OUT_MARKER_FROM_STDOUT"
    echo "ERR_MARKER_FROM_STDERR" >&2
    exit 3
    ;;
  *)
    echo "fake docker: unexpected subcommand $1" >&2
    exit 99
    ;;
esac
`
	if err := os.WriteFile(fakeDocker, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake docker: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	provider := NewDockerProvider("unix:///tmp/agentd-test-exec.sock", nil, 1, "512m")
	sb, err := provider.Create(SandboxSpec{
		Type:           "docker-strict",
		SecurityPolicy: nil,
	})
	if err != nil {
		t.Fatalf("create sandbox for exec test: %v", err)
	}

	// Register the sandbox in the provider's internal map so Exec can
	// resolve it (Create already did this, but be explicit).
	res, err := provider.Exec(sb.ID, "echo hi", nil, 30)
	if err != nil {
		t.Fatalf("Exec returned non-nil error (legacy contract is result,nil even on non-zero exit): %v", err)
	}

	// P8 core assertions: streams separated.
	if !strings.Contains(res.Stdout, "OUT_MARKER_FROM_STDOUT") {
		t.Errorf("Stdout lost its marker; got %q", res.Stdout)
	}
	if strings.Contains(res.Stdout, "ERR_MARKER_FROM_STDERR") {
		t.Errorf("Stdout leaked stderr content (streams crossed!); got %q", res.Stdout)
	}
	if !strings.Contains(res.Stderr, "ERR_MARKER_FROM_STDERR") {
		t.Errorf("Stderr lost its marker; got %q", res.Stderr)
	}
	if strings.Contains(res.Stderr, "OUT_MARKER_FROM_STDOUT") {
		t.Errorf("Stderr leaked stdout content (streams crossed!); got %q", res.Stderr)
	}

	// Exit code + categorized Err.
	if res.ExitCode != 3 {
		t.Errorf("ExitCode: want 3, got %d", res.ExitCode)
	}
	if res.Err == nil {
		t.Errorf("Err must be populated on non-zero exit (P8); got nil")
	} else if !errors.Is(res.Err, ErrNonZeroExit) {
		t.Errorf("Err must be ErrNonZeroExit; got %v", res.Err)
	}
}

// TestDockerProvider_ExecTimeoutCategorized verifies the P8 timeout
// classification: when the exec client is killed by the context
// deadline, result.Err must be errors.Is ErrCommandTimeout so callers
// (e.g. probeHealth, the exec tool) can tell a timeout from a real
// failure and retry with a longer budget.
func TestDockerProvider_ExecTimeoutCategorized(t *testing.T) {
	dir := t.TempDir()
	fakeDocker := filepath.Join(dir, "docker")

	// Fake docker exec that sleeps forever. The provider's 1s timeout
	// will fire and SIGKILL it.
	script := `#!/bin/sh
case "$1" in
  run)
    echo "fake-container-id-for-timeout-test"
    ;;
  exec)
    sleep 30
    ;;
  *)
    exit 99
    ;;
esac
`
	if err := os.WriteFile(fakeDocker, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake docker: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	provider := NewDockerProvider("unix:///tmp/agentd-test-timeout.sock", nil, 1, "512m")
	sb, err := provider.Create(SandboxSpec{Type: "docker-strict"})
	if err != nil {
		t.Fatalf("create sandbox: %v", err)
	}

	res, err := provider.Exec(sb.ID, "sleep 30", nil, 1) // 1s timeout
	if err != nil {
		t.Fatalf("Exec returned non-nil error: %v", err)
	}
	if res.Err == nil {
		t.Fatalf("Err must be populated on timeout; result=%+v", res)
	}
	if !errors.Is(res.Err, ErrCommandTimeout) {
		t.Errorf("Err must be ErrCommandTimeout on context deadline; got %v", res.Err)
	}
	if res.ExitCode != -1 {
		t.Errorf("ExitCode on timeout: want -1, got %d", res.ExitCode)
	}
}
