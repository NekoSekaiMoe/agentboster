//go:build linux

package desktop

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

// canSh returns true if /bin/sh is available for the shell-syntax +
// dry-run tests in this file. Skips the tests otherwise (e.g. on
// macOS dev machines without a real /bin/sh — though these tests
// really only matter on Linux).
func canSh(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh not available; shell tests only run on POSIX hosts")
	}
}

// runSh executes the script under /bin/sh and returns combined stdout +
// stderr + exit error. Helper so tests can assert on the full picture.
func runSh(t *testing.T, script string, env []string) (string, error) {
	t.Helper()
	cmd := exec.Command("sh", "-c", script)
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// waitForFile polls for path to exist until a ~2s budget is exhausted,
// returning nil when it appears. Replaces fixed `sleep 0.1` waits: on a
// slow/loaded CI host the backgrounded icewm can take longer than 100ms
// to exec and write its marker/pidfile, and a fixed sleep flakes. ~2s
// is plenty for exec+write while still failing fast on a real miss.
func waitForFile(t *testing.T, path, script string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s after running script:\n%s", path, script)
}

func TestBuildDbusStartScript_ShellSyntax(t *testing.T) {
	canSh(t)
	script := buildDbusStartScript("/tmp/agentd-desktop", "/tmp/agentd-desktop/desktop-env.sh", ":99")
	// `sh -n` only checks syntax, doesn't run anything. If the script
	// has unmatched quotes / dangling fi / broken redirections, this
	// catches it without needing dbus-launch installed.
	cmd := exec.Command("sh", "-n", "-c", script)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("sh -n reports syntax error: %v\nscript:\n%s\noutput:\n%s",
			err, script, out)
	}
}

func TestBuildIcemwStartScript_ShellSyntax(t *testing.T) {
	canSh(t)
	script := buildIcemwStartScript("/tmp/agentd-desktop/desktop-env.sh", ":99", "/tmp/agentd-desktop/pids")
	cmd := exec.Command("sh", "-n", "-c", script)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("sh -n reports syntax error: %v\nscript:\n%s\noutput:\n%s",
			err, script, out)
	}
}

// TestBuildDbusStartScript_DegradesGracefullyWhenDbusLaunchMissing
// verifies the script's most important invariant: every step is
// guarded, so missing dbus-launch / at-spi-bus-launcher must NOT abort
// the surrounding script. We use PATH override to make all the binaries
// "missing" and check that the script still exits 0.
func TestBuildDbusStartScript_DegradesGracefullyWhenDbusLaunchMissing(t *testing.T) {
	canSh(t)
	tmpDir := t.TempDir()
	envFile := filepath.Join(tmpDir, "desktop-env.sh")
	script := buildDbusStartScript(tmpDir, envFile, ":99")

	// Run with an empty PATH (except the build-time PATH for sh builtins).
	// `command -v` should fail for dbus-launch + at-spi-bus-launcher,
	// skipping both branches. Script must still exit 0.
	out, err := runSh(t, script, []string{"PATH=/usr/bin:/bin"})
	if err != nil {
		t.Fatalf("script must exit 0 with missing binaries; got %v\noutput:\n%s\nscript:\n%s",
			err, out, script)
	}

	// envFile must NOT be created when dbus-launch is missing.
	if _, statErr := os.Stat(envFile); statErr == nil {
		t.Errorf("envFile must not be created when dbus-launch is missing; was created at %s", envFile)
	}
}

// TestBuildDbusStartScript_WritesEnvFileWhenDbusLaunchSucceeds verifies
// the envFile gets written with the right exports when dbus-launch
// succeeds. We stub dbus-launch in a fake PATH that prints a fake
// bus address, and stub at-spi-bus-launcher to short-circuit its branch.
func TestBuildDbusStartScript_WritesEnvFileWhenDbusLaunchSucceeds(t *testing.T) {
	canSh(t)
	fakeBinDir := t.TempDir()
	tmpDir := t.TempDir()
	envFile := filepath.Join(tmpDir, "desktop-env.sh")

	// Fake dbus-launch: emit sh-syntax-compatible env assignments.
	dbusLaunch := "#!/bin/sh\n" +
		`echo 'DBUS_SESSION_BUS_ADDRESS="unix:path=/tmp/fake-bus";'` + "\n" +
		`echo 'export DBUS_SESSION_BUS_ADDRESS;'` + "\n" +
		`echo 'DBUS_SESSION_BUS_PID=12345;'` + "\n"
	if err := os.WriteFile(filepath.Join(fakeBinDir, "dbus-launch"), []byte(dbusLaunch), 0o755); err != nil {
		t.Fatal(err)
	}

	// Fake at-spi-bus-launcher: sleep briefly so the `& sleep 1` branch
	// terminates fast (the script always sleeps 1s after launching it).
	atSpi := "#!/bin/sh\nexit 0\n"
	if err := os.WriteFile(filepath.Join(fakeBinDir, "at-spi-bus-launcher"), []byte(atSpi), 0o755); err != nil {
		t.Fatal(err)
	}

	script := buildDbusStartScript(tmpDir, envFile, ":99")
	out, err := runSh(t, script, []string{
		"PATH=" + fakeBinDir + ":/usr/bin:/bin",
	})
	if err != nil {
		t.Fatalf("script failed with stubs: %v\noutput:\n%s\nscript:\n%s", err, out, script)
	}

	data, statErr := os.ReadFile(envFile)
	if statErr != nil {
		t.Fatalf("envFile should exist after successful run: %v\noutput:\n%s", statErr, out)
	}
	contents := string(data)
	for _, want := range []string{
		"export DISPLAY=:99",
		"export DBUS_SESSION_BUS_ADDRESS=",
		"unix:path=/tmp/fake-bus",
		"export NO_AT_BRIDGE=0",
	} {
		if !strings.Contains(contents, want) {
			t.Errorf("envFile missing %q\nenvFile:\n%s", want, contents)
		}
	}
}

// TestBuildDbusStartScript_NoAtSpiStillWritesEnvFile verifies the
// sub-invariant that D-Bus success without at-spi-bus-launcher still
// produces envFile. This is the "D-Bus up, only the registry missing"
// case — the env file must exist so downstream tools can connect to
// the session bus.
func TestBuildDbusStartScript_NoAtSpiStillWritesEnvFile(t *testing.T) {
	canSh(t)
	fakeBinDir := t.TempDir()
	tmpDir := t.TempDir()
	envFile := filepath.Join(tmpDir, "desktop-env.sh")

	// Stub dbus-launch only — no at-spi-bus-launcher on the fake PATH.
	dbusLaunch := "#!/bin/sh\n" +
		`echo 'DBUS_SESSION_BUS_ADDRESS="unix:path=/tmp/fake-bus";'` + "\n" +
		`echo 'export DBUS_SESSION_BUS_ADDRESS;'` + "\n"
	if err := os.WriteFile(filepath.Join(fakeBinDir, "dbus-launch"), []byte(dbusLaunch), 0o755); err != nil {
		t.Fatal(err)
	}

	script := buildDbusStartScript(tmpDir, envFile, ":99")
	out, err := runSh(t, script, []string{
		"PATH=" + fakeBinDir + ":/usr/bin:/bin",
	})
	if err != nil {
		t.Fatalf("script failed: %v\noutput:\n%s", err, out)
	}

	if _, statErr := os.Stat(envFile); statErr != nil {
		t.Errorf("envFile should be written even without at-spi: %v\noutput:\n%s", statErr, out)
	}
}

// TestBuildIcemwStartScript_ToleratesMissingEnvFile verifies the icewm
// script's `[ -f ] && .` guard: with no envFile present, the script
// must still proceed to start icewm (rather than failing because the
// `source` step references a nonexistent file).
//
// We can't actually start icewm in this environment, but we can run
// the script with a fake icewm on PATH that just exits 0 — proving
// the script reaches the icewm invocation rather than dying at the
// source step. We add a brief sleep after & so the backgrounded icewm
// (which writes the marker) has time to actually exec before the
// outer sh exits.
func TestBuildIcemwStartScript_ToleratesMissingEnvFile(t *testing.T) {
	canSh(t)
	if runtime.GOOS != "linux" {
		t.Skip("icewm script test only meaningful on Linux hosts")
	}
	fakeBinDir := t.TempDir()
	pidDir := t.TempDir()
	missingEnvFile := filepath.Join(t.TempDir(), "does-not-exist.sh")

	// Fake icewm: write a marker so we can prove it was invoked.
	markerPath := filepath.Join(t.TempDir(), "icewm-ran")
	icewm := "#!/bin/sh\necho ran > " + markerPath + "\n"
	if err := os.WriteFile(filepath.Join(fakeBinDir, "icewm"), []byte(icewm), 0o755); err != nil {
		t.Fatal(err)
	}

	script := buildIcemwStartScript(missingEnvFile, ":99", pidDir)
	out, err := runSh(t, script, []string{
		"PATH=" + fakeBinDir + ":/usr/bin:/bin",
	})
	if err != nil {
		t.Fatalf("icewm script must succeed even with missing envFile; got %v\noutput:\n%s\nscript:\n%s",
			err, out, script)
	}
	// Poll for the marker (backgrounded icewm may take >100ms to exec on
	// a loaded host; a fixed sleep flakes). ~2s budget.
	waitForFile(t, markerPath, script)
	waitForFile(t, filepath.Join(pidDir, "icewm.pid"), script)
}

// TestBuildIcemwStartScript_FailingIcewmDoesNotAbortScript verifies the
// P5 degrade path: because icewm is launched via setsid ... &, the
// script returns immediately and an icewm that exits non-zero does NOT
// fail the surrounding startStack script. startStack treats icewm
// failure as non-fatal (Warn + degrade), so the script must exit 0 even
// when the launched icewm dies. This locks that contract with a fake
// icewm that exits 1.
func TestBuildIcemwStartScript_FailingIcewmDoesNotAbortScript(t *testing.T) {
	canSh(t)
	if runtime.GOOS != "linux" {
		t.Skip("icewm script test only meaningful on Linux hosts")
	}
	fakeBinDir := t.TempDir()
	pidDir := t.TempDir()

	// Marker the fake icewm writes BEFORE exiting non-zero, so we can
	// prove the script actually invoked icewm (not just exited 0 because
	// it skipped the launch line). A bare `exit 1` test would pass even
	// if the script never reached icewm at all.
	markerPath := filepath.Join(t.TempDir(), "icewm-invoked")
	icewm := "#!/bin/sh\necho ran > " + markerPath + "\nexit 1\n"
	if err := os.WriteFile(filepath.Join(fakeBinDir, "icewm"), []byte(icewm), 0o755); err != nil {
		t.Fatal(err)
	}
	// PATH must also resolve `setsid` (used by the new sh -c wrapper).
	// Fall back to /usr/bin setsid from the host.
	fakePath := fakeBinDir + ":/usr/bin:/bin"

	// No envFile present (mirrors the missing-envFile tolerance test);
	// the script must reach the icewm invocation regardless.
	missingEnvFile := filepath.Join(t.TempDir(), "does-not-exist.sh")
	script := buildIcemwStartScript(missingEnvFile, ":99", pidDir)
	out, err := runSh(t, script, []string{
		"PATH=" + fakePath,
	})
	if err != nil {
		t.Fatalf("script must exit 0 even when icewm fails (setsid ... & detaches); got %v\noutput:\n%s\nscript:\n%s",
			err, out, script)
	}
	// Poll for marker + pidfile instead of a fixed sleep (CI flake guard).
	waitForFile(t, markerPath, script)
	waitForFile(t, filepath.Join(pidDir, "icewm.pid"), script)
}

// TestXprobeSnippet_Shape locks the X-layer probe shell snippet so a
// refactor can't silently switch it off xset (which ships with Xvfb)
// back onto xdpyinfo (a separate package missing on Alpine).
func TestXprobeSnippet_Shape(t *testing.T) {
	got := xprobeSnippet(":99")
	want := "xset -display :99 q >/dev/null 2>&1"
	if got != want {
		t.Errorf("xprobeSnippet(:99) = %q, want %q", got, want)
	}
}

// TestPortListeningSnippet_Shape locks the /proc/net/tcp port-listen
// probe. It must reference the port in 4 uppercase hex digits and the
// LISTEN state column (0A), with no nc/bash dependency.
func TestPortListeningSnippet_Shape(t *testing.T) {
	cases := []struct {
		port int
		hex  string
	}{
		{5999, "176F"}, // defaultRfbPort
		{6080, "17C0"}, // defaultWebPort
	}
	for _, c := range cases {
		got := portListeningSnippet(c.port)
		// Must reference the 4-digit hex port and parse by awk field
		// ($2 == local_address, $4 == st). An earlier draft used a flat
		// grep `:PORT 0A ` which never matched the real /proc/net/tcp
		// layout (the bytes after :PORT are rem_address, not st).
		if !strings.Contains(got, ":"+c.hex+"$") {
			t.Errorf("portListeningSnippet(%d) = %q, want awk pattern ending in :%s$", c.port, got, c.hex)
		}
		if !strings.Contains(got, "$4 == \"0A\"") {
			t.Errorf("portListeningSnippet(%d) = %q, want awk $4 == 0A (LISTEN state field)", c.port, got)
		}
		// Must check BOTH ipv4 and ipv6 tables — a :: dual-stack listener
		// only appears in /proc/net/tcp6.
		if !strings.Contains(got, "/proc/net/tcp ") || !strings.Contains(got, "/proc/net/tcp6") {
			t.Errorf("portListeningSnippet(%d) = %q, want it to probe both /proc/net/tcp and /proc/net/tcp6", c.port, got)
		}
	}
}

// TestBuildIcemwStartScript_SourcesEnvFileWhenPresent verifies that
// when envFile DOES exist, the script sources it before exec'ing icewm.
// We detect this by putting an `echo $SOURCED_VAR` into the envFile and
// having the fake icewm print its environment — if the var reaches
// icewm, the source succeeded.
func TestBuildIcemwStartScript_SourcesEnvFileWhenPresent(t *testing.T) {
	canSh(t)
	if runtime.GOOS != "linux" {
		t.Skip("icewm script test only meaningful on Linux hosts")
	}
	fakeBinDir := t.TempDir()
	pidDir := t.TempDir()

	// envFile exports a marker var we can detect downstream.
	envFile := filepath.Join(t.TempDir(), "desktop-env.sh")
	envContents := "export SOURCED_FROM_ENVFILE=1\n"
	if err := os.WriteFile(envFile, []byte(envContents), 0o644); err != nil {
		t.Fatal(err)
	}

	// Fake icewm: print the marker var to a file so we can assert it.
	// Write to a temp file + rename so the content appears atomically —
	// `env > marker` truncates/creates the file BEFORE env runs, and the
	// waitForFile poll below can stat the empty file mid-write, reading
	// back an empty dump (observed flake: ~2/100 on a loaded CI host).
	markerPath := filepath.Join(t.TempDir(), "icewm-env")
	icewm := "#!/bin/sh\nenv > " + markerPath + ".tmp\nmv " + markerPath + ".tmp " + markerPath + "\n"
	if err := os.WriteFile(filepath.Join(fakeBinDir, "icewm"), []byte(icewm), 0o755); err != nil {
		t.Fatal(err)
	}

	script := buildIcemwStartScript(envFile, ":99", pidDir)
	out, err := runSh(t, script, []string{
		"PATH=" + fakeBinDir + ":/usr/bin:/bin",
	})
	if err != nil {
		t.Fatalf("icewm script failed: %v\noutput:\n%s", err, out)
	}
	// Poll for the env-dump marker instead of a fixed sleep.
	waitForFile(t, markerPath, script)
	envDump, readErr := os.ReadFile(markerPath)
	if readErr != nil {
		t.Fatalf("could not read icewm env dump: %v", readErr)
	}
	if !strings.Contains(string(envDump), "SOURCED_FROM_ENVFILE=1") {
		t.Errorf("envFile was not sourced into icewm's environment\nenv dump:\n%s", envDump)
	}
}

// TestPidfileDaemonMatch_CoversKnownDaemons verifies the PID-recycle
// guard maps each known pidfile name to the right cmdline substring.
// Without correct mapping, killByPidfile could either leak daemons
// (empty match refuses to kill) or kill unrelated processes (wrong
// match). The four desktop daemons are the only pidfile writers.
func TestPidfileDaemonMatch_CoversKnownDaemons(t *testing.T) {
	cases := map[string]string{
		"xvfb":       "Xvfb",
		"x11vnc":     "x11vnc",
		"websockify": "websockify",
		"icewm":      "icewm",
	}
	for name, want := range cases {
		if got := pidfileDaemonMatch(name); got != want {
			t.Errorf("pidfileDaemonMatch(%q) = %q, want %q", name, got, want)
		}
	}
	// Unknown daemon: return the name itself (NOT empty) so the cmdline
	// identity check still has a pattern to match. An earlier draft
	// returned "" which made grep match anything, bypassing the guard.
	if got := pidfileDaemonMatch("unknown-daemon"); got != "unknown-daemon" {
		t.Errorf("pidfileDaemonMatch(unknown) = %q, want %q (non-empty so the guard stays effective)", got, "unknown-daemon")
	}
}

// TestKillByPidfileScript_SyntaxAndGuards verifies the generated script
// (a) parses cleanly under sh -n (catches the POSIX case-grammar bug an
// earlier draft had — leading '(' before the pattern is rejected by
// dash/ash), and (b) contains the PID-recycle guard tokens so a refactor
// can't silently drop them.
func TestKillByPidfileScript_SyntaxAndGuards(t *testing.T) {
	canSh(t)
	for _, name := range []string{"xvfb", "x11vnc", "websockify", "icewm"} {
		script := killByPidfileScript("/tmp/test.pid", name)
		// Syntax check under real sh.
		cmd := exec.Command("sh", "-n", "-c", script)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Errorf("killByPidfile script for %q has syntax error: %v\nscript:\n%s\noutput:\n%s",
				name, err, script, out)
		}
		daemon := pidfileDaemonMatch(name)
		for _, want := range []string{
			"*[!0-9]*",               // numeric validation
			"/proc/\"$pid\"/cmdline", // PID recycle check
			daemon,                   // daemon name match
		} {
			if !strings.Contains(script, want) {
				t.Errorf("killByPidfile script for %q missing guard token %q\nscript:\n%s", name, want, script)
			}
		}
	}
}

// TestKillByPidfileScript_DoesNotKillUnmatchedProcess is the live PID-
// recycle regression test. It starts a real long-running process (sleep),
// writes its PID into the pidfile AS IF it were xvfb, then runs the
// killByPidfile script for "xvfb". The script must REFUSE to kill it
// because /proc/<pid>/cmdline contains "sleep", not "Xvfb". This is the
// concrete guard against the classic pidfile-recycle misfire.
func TestKillByPidfileScript_DoesNotKillUnmatchedProcess(t *testing.T) {
	canSh(t)
	if runtime.GOOS != "linux" {
		t.Skip("/proc/<pid>/cmdline check is Linux-only")
	}
	// Start a sacrificial process whose PID we will pretend is xvfb.
	sleep := exec.Command("sh", "-c", "sleep 30")
	if err := sleep.Start(); err != nil {
		t.Fatalf("start sacrificial process: %v", err)
	}
	defer func() {
		_ = sleep.Process.Kill()
		_, _ = sleep.Process.Wait()
	}()
	fakePID := sleep.Process.Pid

	// Write the fake PID into a pidfile claiming to be xvfb.
	pidFile := filepath.Join(t.TempDir(), "xvfb.pid")
	if err := os.WriteFile(pidFile, []byte(fmt.Sprintf("%d\n", fakePID)), 0o644); err != nil {
		t.Fatal(err)
	}

	// Run the killByPidfile script for xvfb against this pidfile.
	script := killByPidfileScript(pidFile, "xvfb")
	if _, err := runSh(t, script, nil); err != nil {
		t.Fatalf("script failed: %v\nscript:\n%s", err, script)
	}

	// The sacrificial process must STILL be alive — the script must have
	// refused to kill it because its cmdline says "sleep", not "Xvfb".
	// syscall.Kill(pid, 0) alone isn't strong enough: it succeeds even for
	// a zombie (state Z) or a process that's about to exit. We additionally
	// read /proc/<pid>/cmdline (must still contain "sleep") and check it
	// isn't in state Z (would indicate the guard killed it and it's being
	// reaped). The cmdline check is the real proof the guard held.
	if err := syscall.Kill(fakePID, 0); err != nil {
		t.Fatalf("PID-recycle guard FAILED: killByPidfile killed an unrelated process (cmdline=sleep, not Xvfb). This is the classic pidfile misfire the guard exists to prevent.")
	}
	// /proc/<pid>/cmdline must still identify the sleep process (not Xvfb).
	cmdline, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", fakePID))
	if err != nil {
		t.Fatalf("cannot read /proc/%d/cmdline to verify guard: %v", fakePID, err)
	}
	if !strings.Contains(string(cmdline), "sleep") {
		t.Fatalf("sacrificial process cmdline changed unexpectedly: %q (expected sleep — the guard should NOT have signaled it)", string(cmdline))
	}
	// /proc/<pid>/stat state must not be Z (zombie) — a zombie here would
	// mean the guard killed the process and it's awaiting reap.
	statBytes, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", fakePID))
	if err == nil {
		// stat's 3rd field (after pid and comm) is the state char.
		stat := string(statBytes)
		if rp := strings.LastIndexByte(stat, ')'); rp >= 0 && rp+1 < len(stat) {
			state := stat[rp+1 : rp+3] // " S" / " Z" / etc (space + letter)
			if strings.Contains(state, "Z") {
				t.Fatalf("PID-recycle guard FAILED: sacrificial process is now a zombie (state Z) — killByPidfile killed it despite cmdline=sleep")
			}
		}
	}
}

// TestPortListeningSnippet_RealProcNetTCPLive is the live regression test
// for the portListeningSnippet format bug. An earlier draft used
// `grep ':PORT 0A '` which NEVER matched the real /proc/net/tcp layout
// (the field after :PORT is rem_address, not st) — but the static shape
// test above didn't catch it because it only inspected the generated
// string. This test opens a REAL TCP listener, runs the snippet against
// the live /proc/net/tcp, and requires success; then closes it and
// requires the snippet to fail. If this test had existed from the start
// the bug would have been impossible to ship.
func TestPortListeningSnippet_RealProcNetTCPLive(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("/proc/net/tcp is Linux-only")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("cannot open ephemeral listener: %v", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	snippet := portListeningSnippet(port)
	// Listener is active → snippet must succeed (exit 0).
	if out, err := runSh(t, snippet, nil); err != nil {
		t.Fatalf("snippet must report LISTEN while listener is active; got err=%v\nsnippet:\n%s\nout:\n%s",
			err, snippet, out)
	}

	// Close and re-check: port should no longer be in LISTEN.
	ln.Close()
	if out, err := runSh(t, snippet, nil); err == nil {
		t.Fatalf("snippet must FAIL after listener closed; got success\nsnippet:\n%s\nout:\n%s",
			snippet, out)
	}
}
