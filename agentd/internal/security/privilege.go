//go:build linux
// +build linux

package security

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// DropPrivileges switches from root to the configured unprivileged user.
// Must be called after all root-only setup (PID file, port binding, etc.)
// but before serving agent requests.
func DropPrivileges(username string) error {
	if username == "" || username == "root" {
		slog.Warn("running as root — no privilege drop (set security.run_as_user to a non-root user)")
		return nil
	}

	// Resolve user via getent (works with local users, LDAP, etc.)
	cmd := exec.Command("getent", "passwd", username)
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("user %q not found: %w", username, err)
	}
	fields := strings.Split(strings.TrimSpace(string(out)), ":")
	if len(fields) < 7 {
		return fmt.Errorf("unexpected getent output for user %q", username)
	}

	uid, err := strconv.Atoi(fields[2])
	if err != nil || uid <= 0 {
		return fmt.Errorf("invalid uid for user %q: %s", username, fields[2])
	}
	gid, err := strconv.Atoi(fields[3])
	if err != nil || gid <= 0 {
		return fmt.Errorf("invalid gid for user %q: %s", username, fields[3])
	}
	homeDir := fields[5]
	shell := fields[6]

	slog.Info("dropping privileges",
		"user", username, "uid", uid, "gid", gid, "home", homeDir,
	)

	// Set home and shell env for the target user
	os.Setenv("HOME", homeDir)
	os.Setenv("SHELL", shell)
	os.Setenv("USER", username)
	os.Setenv("LOGNAME", username)

	// Set supplementary groups
	if err := syscall.Setgroups([]int{gid}); err != nil {
		return fmt.Errorf("setgroups: %w", err)
	}
	// Set GID then UID — order matters, once UID drops to non-root we can't change groups
	if err := syscall.Setgid(gid); err != nil {
		return fmt.Errorf("setgid %d: %w", gid, err)
	}
	if err := syscall.Setuid(uid); err != nil {
		return fmt.Errorf("setuid %d: %w", uid, err)
	}

	// Verify we can't go back
	if os.Getuid() == 0 {
		return fmt.Errorf("still root after drop — aborting")
	}

	slog.Info("privileges dropped", "uid", os.Getuid(), "gid", os.Getgid())
	return nil
}
