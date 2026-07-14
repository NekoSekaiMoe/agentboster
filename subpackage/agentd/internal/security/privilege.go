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

// userIdentity is the resolved passwd/group information for the target
// unprivileged user, shared by DropPrivileges and PrepareRuntimeOwnership.
type userIdentity struct {
	uid      int
	gid      int
	groupIDs []int
	homeDir  string
	shell    string
}

// resolveUserIdentity looks up username via getent/id (works with local
// users, LDAP, etc.) and returns its uid/gid/supplementary groups.
func resolveUserIdentity(username string) (*userIdentity, error) {
	cmd := exec.Command("getent", "passwd", username)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("user %q not found: %w", username, err)
	}
	fields := strings.Split(strings.TrimSpace(string(out)), ":")
	if len(fields) < 7 {
		return nil, fmt.Errorf("unexpected getent output for user %q", username)
	}

	uid, err := strconv.Atoi(fields[2])
	if err != nil || uid <= 0 {
		return nil, fmt.Errorf("invalid uid for user %q: %s", username, fields[2])
	}
	gid, err := strconv.Atoi(fields[3])
	if err != nil || gid <= 0 {
		return nil, fmt.Errorf("invalid gid for user %q: %s", username, fields[3])
	}
	groupIDs, err := resolveGroupIDs(username, gid)
	if err != nil {
		return nil, err
	}
	return &userIdentity{
		uid:      uid,
		gid:      gid,
		groupIDs: groupIDs,
		homeDir:  fields[5],
		shell:    fields[6],
	}, nil
}

// PrepareRuntimeOwnership creates the given directories (as root) and hands
// their ownership to the configured unprivileged user, so that after
// DropPrivileges the daemon can still write into them and, crucially, unlink
// files it created inside them (e.g. the PID/socket lock — unlink requires
// write permission on the *parent directory*, not on the file itself).
//
// It is a no-op when no privilege drop will happen (username empty or root),
// because a root-owned daemon can already manage those paths.
//
// Must be called BEFORE DropPrivileges (it needs root to chown).
func PrepareRuntimeOwnership(username string, dirs ...string) error {
	if username == "" || username == "root" {
		return nil
	}
	id, err := resolveUserIdentity(username)
	if err != nil {
		return err
	}
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return fmt.Errorf("create runtime dir %q: %w", dir, err)
		}
		if err := os.Chown(dir, id.uid, id.gid); err != nil {
			return fmt.Errorf("chown runtime dir %q to %s (uid=%d gid=%d): %w",
				dir, username, id.uid, id.gid, err)
		}
	}
	slog.Info("runtime directories prepared for privilege drop",
		"user", username, "uid", id.uid, "gid", id.gid, "dirs", dirs)
	return nil
}

// DropPrivileges switches from root to the configured unprivileged user.
// Must be called after all root-only setup (PID file, port binding,
// PrepareRuntimeOwnership, etc.) but before serving agent requests.
func DropPrivileges(username string) error {
	if username == "" || username == "root" {
		slog.Warn("running as root — no privilege drop (set security.run_as_user to a non-root user)")
		return nil
	}

	id, err := resolveUserIdentity(username)
	if err != nil {
		return err
	}

	slog.Info("dropping privileges",
		"user", username, "uid", id.uid, "gid", id.gid, "groups", id.groupIDs, "home", id.homeDir,
	)

	// Set home and shell env for the target user
	os.Setenv("HOME", id.homeDir)
	os.Setenv("SHELL", id.shell)
	os.Setenv("USER", username)
	os.Setenv("LOGNAME", username)

	// Set the target user's full supplementary group list before dropping UID.
	// This preserves access granted via group membership, such as docker.sock.
	if err := syscall.Setgroups(id.groupIDs); err != nil {
		return fmt.Errorf("setgroups: %w", err)
	}
	// Set GID then UID — order matters, once UID drops to non-root we can't change groups
	if err := syscall.Setgid(id.gid); err != nil {
		return fmt.Errorf("setgid %d: %w", id.gid, err)
	}
	if err := syscall.Setuid(id.uid); err != nil {
		return fmt.Errorf("setuid %d: %w", id.uid, err)
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
