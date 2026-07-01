package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestCLI_EndToEnd builds the helper binary once and runs its
// subcommands as separate processes. This catches integration issues
// that unit tests on the library miss:
//
//   - flag parsing + dispatch in main.go (cmd vs. lib)
//   - stdout JSON envelope shape (the wire format agentd parses)
//   - stderr / exit-code contract for error paths
//   - the binary actually builds (cross-file imports resolve)
//
// We skip rather than fail when the toolchain can't build — this test
// only runs meaningfully on a Linux dev box.
func TestCLI_EndToEnd(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go toolchain not on PATH; cannot build helper for integration test")
	}

	// Build the binary once into a per-test tempdir. t.TempDir is
	// unique per-test invocation, so parallel tests don't collide.
	binPath := filepath.Join(t.TempDir(), "a11y-helper")
	build := exec.Command("go", "build", "-o", binPath, "./")
	var buildErr bytes.Buffer
	build.Stderr = &buildErr
	if err := build.Run(); err != nil {
		t.Fatalf("go build: %v\n%s", err, buildErr.String())
	}

	// ── --help / no-args → usage on stderr, exit 2 ────────────────

	t.Run("help_exits_0_with_usage", func(t *testing.T) {
		out, err := exec.Command(binPath, "--help").CombinedOutput()
		if err != nil {
			t.Fatalf("--help: expected exit 0 (explicit help request), got %v", err)
		}
		s := string(out)
		for _, want := range []string{"snapshot", "click", "type", "fill"} {
			if !strings.Contains(s, want) {
				t.Errorf("usage text missing %q:\n%s", want, s)
			}
		}
	})

	t.Run("no_args_exits_2_with_usage", func(t *testing.T) {
		// Empty argv → usage error → exit 2.
		out, err := exec.Command(binPath).CombinedOutput()
		if err == nil {
			t.Fatalf("no args: expected non-zero exit")
		}
		if exitErr, ok := err.(*exec.ExitError); !ok || exitErr.ExitCode() != 2 {
			t.Fatalf("no args: expected exit 2, got %v", err)
		}
		if !strings.Contains(string(out), "snapshot") {
			t.Errorf("usage text missing on no-args invocation:\n%s", out)
		}
	})

	t.Run("unknown_subcommand_exits_2", func(t *testing.T) {
		out, err := exec.Command(binPath, "frobnicate").CombinedOutput()
		if err == nil {
			t.Fatalf("unknown subcommand: expected non-zero exit")
		}
		if !strings.Contains(string(out), "unknown subcommand") {
			t.Errorf("expected 'unknown subcommand' in output:\n%s", out)
		}
	})

	t.Run("snapshot_without_dbus_exits_1_with_stderr", func(t *testing.T) {
		// Run without AT_SPI_BUS_ADDRESS / DBUS_SESSION_BUS_ADDRESS
		// (cleared env). The helper must surface a clear error on
		// stderr, NOT print anything to stdout, and exit 1.
		cmd := exec.Command(binPath, "snapshot")
		cmd.Env = []string{"PATH=/usr/bin:/bin", "DISPLAY=:99"} // no bus env
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		err := cmd.Run()
		if err == nil {
			t.Fatalf("snapshot: expected non-zero exit without D-Bus")
		}
		if exitErr, ok := err.(*exec.ExitError); !ok || exitErr.ExitCode() != 1 {
			t.Fatalf("snapshot: expected exit code 1, got %v", err)
		}
		if stdout.Len() > 0 {
			t.Errorf("snapshot must produce NO stdout when bus is unreachable; got %q", stdout.String())
		}
		// stderr must contain a meaningful error for the agentd logs.
		if !strings.Contains(stderr.String(), "no AT-SPI accessibility bus") {
			t.Errorf("snapshot stderr should explain bus discovery failed:\n%s", stderr.String())
		}
	})

	t.Run("click_without_refs_file_exits_0_with_error_envelope", func(t *testing.T) {
		// Click/type look up the ref in /tmp/agentd-a11y-refs.json by
		// default. Without that file present, the helper MUST still
		// exit 0 (it's a per-action failure, not a catastrophic one)
		// and emit a JSON envelope with ok=false on stdout. This is
		// the wire-format contract agentd depends on for fallback.
		refsPath := filepath.Join(t.TempDir(), "missing-refs.json")
		cmd := exec.Command(binPath, "click", "e3")
		cmd.Env = []string{
			"PATH=/usr/bin:/bin",
			"AGENTD_A11Y_REFS=" + refsPath,
		}
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		err := cmd.Run()
		if err != nil {
			t.Fatalf("click on missing refs: expected exit 0 (per-action failure), got %v\nstderr:\n%s", err, stderr.String())
		}
		// stdout must be a single JSON object with ok=false and the
		// requested ref echoed back.
		var env struct {
			OK     bool   `json:"ok"`
			Action string `json:"action"`
			RefID  string `json:"ref"`
			Error  string `json:"error"`
		}
		if err := json.Unmarshal(stdout.Bytes(), &env); err != nil {
			t.Fatalf("click output is not valid JSON: %v\nraw: %q", err, stdout.String())
		}
		if env.OK {
			t.Errorf("ok = true, want false (ref must not resolve)")
		}
		if env.Action != "click" {
			t.Errorf("action = %q, want \"click\"", env.Action)
		}
		if env.RefID != "e3" {
			t.Errorf("ref = %q, want \"e3\"", env.RefID)
		}
		if env.Error == "" {
			t.Errorf("error message is empty; should explain the refs file is missing")
		}
	})

	t.Run("snapshot_limit_flag_parses", func(t *testing.T) {
		// Even though snapshot will fail without D-Bus, the limit flag
		// must still parse (otherwise the helper exits 2 before even
		// trying). Verify that --limit 50 + --limit=75 are accepted.
		for _, args := range [][]string{
			{"snapshot", "--limit", "50"},
			{"snapshot", "--limit=75"},
		} {
			cmd := exec.Command(binPath, args...)
			cmd.Env = []string{"PATH=/usr/bin:/bin", "DISPLAY=:99"}
			err := cmd.Run()
			// Should exit 1 (D-Bus unreachable), NOT 2 (usage error).
			if exitErr, ok := err.(*exec.ExitError); !ok || exitErr.ExitCode() != 1 {
				t.Errorf("snapshot %v: expected exit 1 (D-Bus down), got %v", args, err)
			}
		}
	})
}

// TestMain wires nothing special; we just need the standard test entry.
// Kept as a no-op to make the integration test file's intent explicit
// (no global setup/teardown).
func TestMain_NoOp(t *testing.T) {
	_ = os.Getenv("UNUSED_BUT_FORCES_OS_IMPORT")
}
