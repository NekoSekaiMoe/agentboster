//go:build linux
// +build linux

package security

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
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
		if err := mkdirAndChownSafe(dir, id.uid, id.gid); err != nil {
			return fmt.Errorf("prepare runtime dir %q for %s (uid=%d gid=%d): %w",
				dir, username, id.uid, id.gid, err)
		}
	}
	slog.Info("runtime directories prepared for privilege drop",
		"user", username, "uid", id.uid, "gid", id.gid, "dirs", dirs)
	return nil
}

// mkdirAndChownSafe creates dir (and any missing parents) and chowns the
// leaf to uid/gid, WITHOUT ever following an untrusted symlink — defeating
// the classic /tmp symlink attack. The daemon runs this as root before the
// privilege drop, and several default paths ([cache].path=/tmp/agentd,
// [session].store_path=/tmp/agentd/sessions) live under the world-writable
// /tmp, where a local attacker can pre-plant a symlink (e.g. /tmp/agentd ->
// /etc). A naive os.MkdirAll+os.Chown would treat the symlink as an existing
// directory and chown its *target*, handing an arbitrary directory to the
// unprivileged user — a local privilege escalation.
//
// The walk mirrors systemd's CHASE_SAFE semantics:
//   - Each path component is opened with O_NOFOLLOW | O_DIRECTORY relative to
//     its parent fd (openat), so a symlink component is never dereferenced
//     implicitly.
//   - A symlink component is followed ONLY when its parent directory is not
//     writable by non-root (owned by root/uid and lacking group/other write
//     bits). This is what lets the legitimate /var/run -> /run symlink work
//     (its parent /var is root:root 0755) while refusing /tmp/agentd -> /etc
//     (its parent /tmp is world-writable, mode 1777).
//   - Missing components are created with mkdirat (relative to the parent fd),
//     so a freshly created directory can never be a symlink — no TOCTOU.
//   - The leaf is chowned via fchown on its O_NOFOLLOW fd, so we never chown
//     through a symlink even if one races into place.
func mkdirAndChownSafe(dir string, uid, gid int) error {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	clean := filepath.Clean(abs)
	components := strings.Split(strings.TrimPrefix(clean, "/"), "/")

	// Open the root directory as the anchor fd. "/" is trusted.
	parentFd, err := unix.Open("/", unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("open /: %w", err)
	}
	// parentPath tracks the resolved path of parentFd for trust decisions
	// and error messages.
	parentPath := "/"
	defer func() { _ = unix.Close(parentFd) }()

	for i, name := range components {
		if name == "" || name == "." {
			continue
		}
		isLeaf := i == len(components)-1

		childFd, cerr := openChildSafe(parentFd, parentPath, name, uid, gid, isLeaf)
		if cerr != nil {
			return cerr
		}
		_ = unix.Close(parentFd)
		parentFd = childFd
		parentPath = filepath.Join(parentPath, name)
	}

	// parentFd now refers to the leaf directory, opened without following a
	// symlink leaf. It is an O_PATH fd, so a plain fchown(2) would fail with
	// EBADF; chown it via fchownat with an empty pathname + AT_EMPTY_PATH,
	// which operates directly on the fd (the canonical way to chown an O_PATH
	// descriptor).
	if err := unix.Fchownat(parentFd, "", uid, gid, unix.AT_EMPTY_PATH); err != nil {
		return fmt.Errorf("fchownat %q: %w", parentPath, err)
	}
	return nil
}

// openChildSafe opens (or creates) the single path component `name` inside
// the directory referred to by parentFd, never dereferencing an untrusted
// symlink. Returns an O_DIRECTORY fd for the child.
func openChildSafe(parentFd int, parentPath, name string, uid, gid int, isLeaf bool) (int, error) {
	// Fast path: component exists as a real directory (not a symlink).
	fd, err := unix.Openat(parentFd, name, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
	if err == nil {
		return fd, nil
	}

	// ELOOP / ENOTDIR from O_NOFOLLOW means the component is a symlink (or a
	// non-directory). Decide whether following it is safe based on the parent.
	if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
		return followOrRefuseSymlink(parentFd, parentPath, name)
	}

	// ENOENT: component does not exist — create it atomically relative to
	// parentFd. A mkdirat'd directory cannot be a pre-existing symlink.
	if errors.Is(err, unix.ENOENT) {
		if mkErr := unix.Mkdirat(parentFd, name, 0o750); mkErr != nil && !errors.Is(mkErr, unix.EEXIST) {
			return -1, fmt.Errorf("mkdirat %q in %q: %w", name, parentPath, mkErr)
		}
		fd, err = unix.Openat(parentFd, name, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
		if err != nil {
			return -1, fmt.Errorf("open freshly created %q in %q: %w", name, parentPath, err)
		}
		return fd, nil
	}

	return -1, fmt.Errorf("openat %q in %q: %w", name, parentPath, err)
}

// followOrRefuseSymlink is called when `name` inside parentFd is a symlink.
// It follows the symlink only if parentFd's directory is not writable by
// non-root users; otherwise it refuses (the /tmp attack case).
func followOrRefuseSymlink(parentFd int, parentPath, name string) (int, error) {
	var st unix.Stat_t
	if err := unix.Fstat(parentFd, &st); err != nil {
		return -1, fmt.Errorf("fstat parent %q: %w", parentPath, err)
	}
	// Parent is trusted only if owned by root (uid 0) and not group/other
	// writable. Anything else (e.g. /tmp at 1777, or a user-owned dir) means
	// a non-root actor could have planted this symlink.
	if st.Uid != 0 || st.Mode&(unix.S_IWGRP|unix.S_IWOTH) != 0 {
		return -1, fmt.Errorf(
			"refusing to follow symlink %q: parent %q is writable by non-root (uid=%d mode=%#o) — possible symlink attack",
			name, parentPath, st.Uid, st.Mode&0o7777)
	}

	// Trusted parent: resolve the symlink target and open it with the same
	// safe walk from root, so nested symlinks are also validated.
	target, err := readlinkAt(parentFd, name)
	if err != nil {
		return -1, fmt.Errorf("readlinkat %q in %q: %w", name, parentPath, err)
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(parentPath, target)
	}
	// Re-walk the (now trusted) absolute target. Depth is bounded by the
	// filesystem; a malicious loop would be under a root-owned dir, which we
	// treat as an operator problem, not an attacker one.
	fd, err := unix.Open(filepath.Clean(target), unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
	if err == nil {
		return fd, nil
	}
	// Target may itself be a symlink or not yet exist; fall back to a plain
	// open that follows (target lives under a trusted, root-owned tree).
	fd, err = unix.Open(filepath.Clean(target), unix.O_PATH|unix.O_DIRECTORY, 0)
	if err != nil {
		return -1, fmt.Errorf("open symlink target %q (from %q/%q): %w", target, parentPath, name, err)
	}
	return fd, nil
}

// readlinkAt reads the target of the symlink `name` relative to dirFd.
func readlinkAt(dirFd int, name string) (string, error) {
	buf := make([]byte, unix.PathMax)
	n, err := unix.Readlinkat(dirFd, name, buf)
	if err != nil {
		return "", err
	}
	return string(buf[:n]), nil
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
