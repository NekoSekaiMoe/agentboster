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
	groupIDs, err := resolveGroupIDs(username, gid)
	if err != nil {
		return err
	}
	homeDir := fields[5]
	shell := fields[6]

	slog.Info("dropping privileges",
		"user", username, "uid", uid, "gid", gid, "groups", groupIDs, "home", homeDir,
	)

	// Set home and shell env for the target user
	os.Setenv("HOME", homeDir)
	os.Setenv("SHELL", shell)
	os.Setenv("USER", username)
	os.Setenv("LOGNAME", username)

	// Set the target user's full supplementary group list before dropping UID.
	// This preserves access granted via group membership, such as docker.sock.
	if err := syscall.Setgroups(groupIDs); err != nil {
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

func resolveGroupIDs(username string, primaryGID int) ([]int, error) {
	cmd := exec.Command("id", "-G", username)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("groups for user %q not found: %w", username, err)
	}
	return parseGroupIDs(string(out), primaryGID)
}

func parseGroupIDs(output string, primaryGID int) ([]int, error) {
	seen := map[int]struct{}{}
	var groupIDs []int

	add := func(gid int) {
		if gid <= 0 {
			return
		}
		if _, ok := seen[gid]; ok {
			return
		}
		seen[gid] = struct{}{}
		groupIDs = append(groupIDs, gid)
	}

	add(primaryGID)
	for _, field := range strings.Fields(output) {
		gid, err := strconv.Atoi(field)
		if err != nil || gid <= 0 {
			return nil, fmt.Errorf("invalid group id %q", field)
		}
		add(gid)
	}

	if len(groupIDs) == 0 {
		return nil, fmt.Errorf("no groups resolved for primary gid %d", primaryGID)
	}
	return groupIDs, nil
}
