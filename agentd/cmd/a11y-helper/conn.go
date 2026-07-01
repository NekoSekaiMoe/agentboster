// Bus discovery for the AT-SPI2 accessibility bus.
//
// The a11y bus is a *separate* D-Bus daemon from the session bus. The
// session bus exposes its address via org.a11y.Bus.GetAddress, but
// inside the agentd sandbox the helper is exec'd with no guarantee
// that DBUS_SESSION_BUS_ADDRESS points anywhere useful (or is set at
// all). We mirror memoh's strategy: discover the a11y bus address
// ourselves by (a) trusting AT_SPI_BUS_ADDRESS if its backing socket
// is live, (b) scanning /proc/*/cmdline for any at-spi dbus-daemon
// and extracting its --address=, (c) probing well-known cache paths
// under XDG_RUNTIME_DIR / HOME / /tmp.

package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/godbus/dbus/v5"
)

// openA11yBus connects to the AT-SPI2 accessibility bus, returning a
// fresh *dbus.Conn bound to the discovered bus address. The discovery
// order matches memoh's connection.rs.
func openA11yBus() (*dbus.Conn, error) {
	addr, err := resolveBusAddress()
	if err != nil {
		return nil, err
	}
	// godbus.SessionBus/Private dial from DBUS_SESSION_BUS_ADDRESS; for
	// the a11y bus we want a direct dial against the discovered address.
	// dbus.Dial takes a transport address like
	// "unix:path=/run/user/1000/at-spi/bus" — exactly what resolveBusAddress
	// returns.
	conn, err := dbus.Dial(addr)
	if err != nil {
		return nil, fmt.Errorf("dial AT-SPI bus %s: %w", addr, err)
	}
	// Auth must happen before any calls. The a11y bus uses standard
	// EXTERNAL cookie auth (the daemon runs as our uid, so the default
	// external auth works without credentials passing).
	if err := conn.Auth(nil); err != nil {
		conn.Close()
		return nil, fmt.Errorf("auth AT-SPI bus %s: %w", addr, err)
	}
	return conn, nil
}

// resolveBusAddress figures out which D-Bus address the AT-SPI registry
// daemon is listening on, in order:
//
//  1. AT_SPI_BUS_ADDRESS env var (only if the backing socket is live —
//     stale values after daemon restarts are a classic source of "a11y
//     doesn't work after logout").
//  2. /proc/*/cmdline scan for any `dbus-daemon ... at-spi ...
//     accessibility.conf` and extract its --address=. Most recent PID
//     wins (the daemon may have been restarted).
//  3. Well-known cache paths written by at-spi-bus-launcher:
//     $XDG_RUNTIME_DIR/at-spi/bus_<display>, $HOME/.cache/at-spi/bus_<display>,
//     /tmp/at-spi/bus_<display>. These files contain the address as a
//     single line ending in \n; we treat them as socket paths.
//
// We deliberately do NOT call org.a11y.Bus.GetAddress on the session
// bus: in the sandbox there is no guarantee a session bus is reachable
// from this process, and bypassing it removes a circular dependency.
func resolveBusAddress() (string, error) {
	if addr := os.Getenv("AT_SPI_BUS_ADDRESS"); addr != "" {
		if socketAlive(addr) {
			return addr, nil
		}
		os.Unsetenv("AT_SPI_BUS_ADDRESS")
	}

	for _, addr := range scanProcForBusAddresses() {
		if socketAlive(addr) {
			return addr, nil
		}
	}

	display := displayNumber(os.Getenv("DISPLAY"))
	xdgRuntime := os.Getenv("XDG_RUNTIME_DIR")
	home := os.Getenv("HOME")
	for _, p := range candidateCachePaths(display, xdgRuntime, home) {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return "unix:path=" + p, nil
		}
	}

	return "", errors.New("no AT-SPI accessibility bus address could be resolved (no live --address= in /proc and no socket at cache paths)")
}

// socketAlive verifies that a unix:path=... address actually accepts a
// connection. A daemon that crashed leaves a stale socket file
// (connect → ECONNREFUSED); a daemon that never bound its requested
// path gives ENOENT. We catch both so we don't lock ourselves into a
// dead address.
//
// Abstract sockets (unix:abstract=...) have no filesystem representation
// and are trusted as-is — connect() inside godbus will surface any error.
func socketAlive(addr string) bool {
	for _, part := range strings.Split(addr, ",") {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(part, "unix:path=") {
			path := strings.TrimPrefix(part, "unix:path=")
			conn, err := net.Dial("unix", path)
			if err != nil {
				return false
			}
			_ = conn.Close()
			return true
		}
		if strings.HasPrefix(part, "unix:abstract=") {
			return true // can't verify without dialing; trust it
		}
	}
	return true // unknown transport — trust the caller
}

// displayNumber strips the leading colon and trailing ".N" from an X11
// DISPLAY string (":99.0" → "99", ":0" → "0"). Defaults to "0".
func displayNumber(display string) string {
	d := strings.TrimSpace(display)
	d = strings.TrimPrefix(d, ":")
	if i := strings.IndexByte(d, '.'); i >= 0 {
		d = d[:i]
	}
	if d == "" {
		return "0"
	}
	if _, err := strconv.Atoi(d); err != nil {
		return "0"
	}
	return d
}

// candidateCachePaths returns the ordered list of cache files to probe
// when /proc discovery turns up nothing. Matches at-spi-bus-launcher's
// own write locations across distros (some honor $XDG_RUNTIME_DIR,
// some fall back to $HOME/.cache, Android-derived images use /data).
func candidateCachePaths(display, xdgRuntime, home string) []string {
	leaf := fmt.Sprintf("at-spi/bus_%s", display)
	var paths []string
	if xdgRuntime != "" {
		paths = append(paths,
			filepath.Join(xdgRuntime, leaf),
			filepath.Join(xdgRuntime, "at-spi", "bus"),
		)
	}
	if home != "" {
		paths = append(paths, filepath.Join(home, ".cache", leaf))
	}
	paths = append(paths,
		filepath.Join("/data/.cache", leaf),
		filepath.Join("/root/.cache", leaf),
		filepath.Join("/tmp", leaf),
	)
	return paths
}

// scanProcForBusAddresses walks /proc/*/cmdline and pulls --address=
// from every running dbus-daemon pointed at an at-spi/accessibility.conf
// config. Results are sorted by PID descending so callers prefer the
// most recent restart (the older daemon may be shutting down).
//
// We intentionally read cmdline as raw bytes and split on NUL: /proc is
// not a regular filesystem, and Go's bufio on /proc files behaves
// correctly with ReadFile but not with line-oriented helpers.
func scanProcForBusAddresses() []string {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var found []procAddr
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid, err := strconv.ParseUint(entry.Name(), 10, 64)
		if err != nil {
			continue // not a PID directory
		}
		cmdline, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "cmdline"))
		if err != nil {
			continue
		}
		argv := strings.Split(strings.TrimRight(string(cmdline), "\x00"), "\x00")
		if len(argv) == 0 {
			continue
		}
		// Match memoh's heuristic: argv contains both "at-spi" and
		// "accessibility.conf" somewhere. This catches
		// `dbus-daemon --config-file=/usr/share/at-spi2-core/accessibility.conf
		// --address=...` regardless of argv ordering.
		isATSPI := false
		for _, a := range argv {
			if strings.Contains(a, "at-spi") && strings.Contains(a, "accessibility.conf") {
				isATSPI = true
				break
			}
		}
		if !isATSPI {
			continue
		}
		for _, a := range argv {
			if addr := strings.TrimPrefix(a, "--address="); addr != a {
				found = append(found, procAddr{pid: pid, addr: addr})
			}
		}
	}
	sort.Slice(found, func(i, j int) bool { return found[i].pid > found[j].pid })
	addrs := make([]string, len(found))
	for i, f := range found {
		addrs[i] = f.addr
	}
	return addrs
}

type procAddr struct {
	pid  uint64
	addr string
}
