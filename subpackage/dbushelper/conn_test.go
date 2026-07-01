package dbushelper

import (
	"os"
	"path/filepath"
	"testing"
)

// writeFakeProcPid writes a fake /proc/<pid>/cmdline for one process.
// cmdline is the raw bytes (callers should include NUL separators).
func writeFakeProcPid(t *testing.T, procRoot, pid string, cmdline []byte) {
	t.Helper()
	dir := filepath.Join(procRoot, pid)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "cmdline"), cmdline, 0o644); err != nil {
		t.Fatalf("write cmdline: %v", err)
	}
}

// cmdline joins argv with NUL bytes and adds a trailing NUL, matching
// the real /proc/<pid>/cmdline format.
func cmdline(argv ...string) []byte {
	out := make([]byte, 0)
	for i, a := range argv {
		if i > 0 {
			out = append(out, 0)
		}
		out = append(out, []byte(a)...)
	}
	return append(out, 0)
}

func TestScanProcForBusAddresses_FindsAtSpiDaemon(t *testing.T) {
	procRoot := t.TempDir()

	// PID 100: a normal unrelated process.
	writeFakeProcPid(t, procRoot, "100",
		cmdline("/usr/bin/agentd", "-config", "agentd.toml"))
	// PID 200: an at-spi dbus-daemon with an address.
	writeFakeProcPid(t, procRoot, "200",
		cmdline("/usr/bin/dbus-daemon",
			"--config-file=/usr/share/at-spi2-core/accessibility.conf",
			"--address=unix:path=/tmp/at-spi/bus_99",
			"--nofork", "--print-address"))

	// PID 300: a non-at-spi dbus-daemon (the session bus) — must be skipped.
	writeFakeProcPid(t, procRoot, "300",
		cmdline("/usr/bin/dbus-daemon", "--session", "--address=unix:path=/tmp/session-bus"))

	// PID 400: a second at-spi daemon (most recent restart).
	writeFakeProcPid(t, procRoot, "400",
		cmdline("/usr/bin/dbus-daemon",
			"--config-file=/usr/share/at-spi2-core/accessibility.conf",
			"--address=unix:path=/tmp/at-spi/bus_99_new"))

	// Also drop some non-numeric and non-directory entries to verify
	// they're skipped without error.
	if err := os.WriteFile(filepath.Join(procRoot, "cpuinfo"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write cpuinfo: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(procRoot, "self"), 0o755); err != nil {
		t.Fatalf("mkdir self: %v", err)
	}

	addrs := scanProcForBusAddresses(procRoot)
	if len(addrs) != 2 {
		t.Fatalf("got %d addresses, want 2: %+v", len(addrs), addrs)
	}
	// PID 400 (highest) must come first.
	wantFirst := "unix:path=/tmp/at-spi/bus_99_new"
	if addrs[0] != wantFirst {
		t.Errorf("addrs[0] = %q, want %q (highest-PID-first ordering)", addrs[0], wantFirst)
	}
	if addrs[1] != "unix:path=/tmp/at-spi/bus_99" {
		t.Errorf("addrs[1] = %q, want the lower-PID address", addrs[1])
	}
}

func TestScanProcForBusAddresses_EmptyProcRoot(t *testing.T) {
	procRoot := t.TempDir()
	if got := scanProcForBusAddresses(procRoot); len(got) != 0 {
		t.Errorf("empty proc root: got %+v, want empty", got)
	}
}

func TestScanProcForBusAddresses_MissingRoot(t *testing.T) {
	// A nonexistent path returns nil rather than panicking — important
	// because in some sandboxes /proc may not be mounted.
	if got := scanProcForBusAddresses("/this/does/not/exist"); len(got) != 0 {
		t.Errorf("missing proc root: got %+v, want empty", got)
	}
}

func TestScanProcForBusAddresses_AcceptsPathWithoutConfigFlag(t *testing.T) {
	// memoh's heuristic is "argv contains both 'at-spi' and
	// 'accessibility.conf' anywhere". Verify an entry that has the
	// substrings split across multiple argv elements still matches.
	procRoot := t.TempDir()
	writeFakeProcPid(t, procRoot, "123",
		cmdline("dbus-daemon",
			"--config-file", "/usr/share/at-spi2-core/accessibility.conf",
			"--address=unix:abstract=/tmp/x"))
	// Both substrings present but in different argv elements — should match.
	got := scanProcForBusAddresses(procRoot)
	if len(got) != 1 {
		t.Fatalf("expected 1 match for split substrings, got %d: %+v", len(got), got)
	}
}

func TestSocketAlive_UnixPathAlive(t *testing.T) {
	// Create a real listening unix socket and verify SocketAlive
	// accepts its address.
	dir := t.TempDir()
	sockPath := filepath.Join(dir, "sock")
	ln, err := listenUnix(sockPath)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	addr := "unix:path=" + sockPath
	if !SocketAlive(addr) {
		t.Errorf("SocketAlive(%q) = false, want true", addr)
	}
}

func TestSocketAlive_UnixPathMissing(t *testing.T) {
	addr := "unix:path=" + filepath.Join(t.TempDir(), "does-not-exist")
	if SocketAlive(addr) {
		t.Errorf("SocketAlive(missing path) = true, want false")
	}
}

func TestSocketAlive_AcceptsAbstractWithoutCheck(t *testing.T) {
	// Abstract sockets have no filesystem representation; the helper
	// trusts them rather than failing the connection-test step (any
	// actual error surfaces when godbus dials).
	if !SocketAlive("unix:abstract=@some-abstract-name") {
		t.Errorf("SocketAlive(abstract) = false, want true (trusted blindly)")
	}
}

func TestSocketAlive_StaleSocketFile(t *testing.T) {
	// A file that exists but is NOT a listening socket must fail the
	// alive check. This simulates a daemon that crashed and left its
	// socket file behind (connect → ECONNREFUSED).
	dir := t.TempDir()
	stalePath := filepath.Join(dir, "stale")
	if err := os.WriteFile(stalePath, []byte("not a socket"), 0o644); err != nil {
		t.Fatalf("write stale: %v", err)
	}
	if SocketAlive("unix:path=" + stalePath) {
		t.Errorf("SocketAlive(non-socket file) = true, want false")
	}
}

func TestResolveBusAddress_PrefersEnvVarIfSocketAlive(t *testing.T) {
	// Build a live socket + address that should be preferred over the
	// cache-path fallback.
	dir := t.TempDir()
	sockPath := filepath.Join(dir, "atspi")
	ln, err := listenUnix(sockPath)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	t.Setenv("AT_SPI_BUS_ADDRESS", "unix:path="+sockPath)
	t.Setenv("XDG_RUNTIME_DIR", "")
	t.Setenv("HOME", "")

	got, err := resolveBusAddress()
	if err != nil {
		t.Fatalf("resolveBusAddress: %v", err)
	}
	if want := "unix:path=" + sockPath; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestResolveBusAddress_StaleEnvVarRediscoveredFromCache(t *testing.T) {
	// A stale env var pointing at a dead socket must NOT be returned;
	// the cache-path probe is the next fallback.
	dir := t.TempDir()

	// Stale env var (path doesn't exist).
	t.Setenv("AT_SPI_BUS_ADDRESS", "unix:path="+filepath.Join(dir, "dead"))

	// CandidateCachePaths returns $XDG_RUNTIME_DIR/at-spi/bus_<display>
	// as its first entry when XDG_RUNTIME_DIR is set. Create the file
	// so the probe finds it.
	t.Setenv("XDG_RUNTIME_DIR", dir)
	t.Setenv("HOME", "")
	t.Setenv("DISPLAY", ":99")

	cacheLeaf := filepath.Join(dir, "at-spi", "bus_99")
	if err := os.MkdirAll(filepath.Dir(cacheLeaf), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cacheLeaf, []byte("placeholder-not-real-socket"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := resolveBusAddress()
	if err != nil {
		t.Fatalf("resolveBusAddress: %v", err)
	}
	want := "unix:path=" + cacheLeaf
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestResolveBusAddress_NothingAvailable(t *testing.T) {
	// No env var, no /proc matches, no cache paths — must return a
	// descriptive error rather than panicking.
	t.Setenv("AT_SPI_BUS_ADDRESS", "")
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	t.Setenv("DISPLAY", ":99")

	_, err := resolveBusAddress()
	if err == nil {
		t.Fatalf("expected error when nothing resolves, got nil")
	}
}
