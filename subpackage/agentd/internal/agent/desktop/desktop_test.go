package desktop

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
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

	script := buildIcemwStartScript(missingEnvFile, ":99", pidDir) + "; sleep 0.1"
	out, err := runSh(t, script, []string{
		"PATH=" + fakeBinDir + ":/usr/bin:/bin",
	})
	if err != nil {
		t.Fatalf("icewm script must succeed even with missing envFile; got %v\noutput:\n%s\nscript:\n%s",
			err, out, script)
	}
	if _, statErr := os.Stat(markerPath); statErr != nil {
		t.Errorf("icewm was not invoked (marker %s absent): %v\noutput:\n%s",
			markerPath, statErr, out)
	}
	pidFile := filepath.Join(pidDir, "icewm.pid")
	if _, statErr := os.Stat(pidFile); statErr != nil {
		t.Errorf("icewm.pid not written: %v", statErr)
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
	markerPath := filepath.Join(t.TempDir(), "icewm-env")
	icewm := "#!/bin/sh\nenv > " + markerPath + "\n"
	if err := os.WriteFile(filepath.Join(fakeBinDir, "icewm"), []byte(icewm), 0o755); err != nil {
		t.Fatal(err)
	}

	script := buildIcemwStartScript(envFile, ":99", pidDir) + "; sleep 0.1"
	out, err := runSh(t, script, []string{
		"PATH=" + fakeBinDir + ":/usr/bin:/bin",
	})
	if err != nil {
		t.Fatalf("icewm script failed: %v\noutput:\n%s", err, out)
	}

	envDump, readErr := os.ReadFile(markerPath)
	if readErr != nil {
		t.Fatalf("could not read icewm env dump: %v", readErr)
	}
	if !strings.Contains(string(envDump), "SOURCED_FROM_ENVFILE=1") {
		t.Errorf("envFile was not sourced into icewm's environment\nenv dump:\n%s", envDump)
	}
}
