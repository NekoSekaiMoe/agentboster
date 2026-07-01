//go:build linux

package dbushelper

import "net"

// listenUnix binds a listening SOCK_STREAM unix socket at path. Used by
// tests to create real sockets for SocketAlive / resolveBusAddress to
// probe. Linux-only — these tests don't run on macOS/Windows (the
// production helper is Linux-only anyway via atspi.go's build tag).
func listenUnix(path string) (net.Listener, error) {
	return net.Listen("unix", path)
}
