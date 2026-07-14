//go:build linux

package security

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

// These tests must run as root: mkdirAndChownSafe chowns to an arbitrary
// uid/gid, which only root may do. They are skipped for the ordinary
// unprivileged `go test` run and exercised explicitly via
//   sudo go test -run TestMkdirAndChownSafe ./internal/security/...
// The symlink-refusal assertions are the security-critical ones.

const (
	testUID = 60000 // an unprivileged uid we chown targets to
	testGID = 60000
)

func requireRoot(t *testing.T) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("must run as root (sudo go test -run TestMkdirAndChownSafe ...)")
	}
}

func ownerUID(t *testing.T, path string) uint32 {
	t.Helper()
	var st unix.Stat_t
	if err := unix.Lstat(path, &st); err != nil {
		t.Fatalf("lstat %q: %v", path, err)
	}
	return st.Uid
}

// TestMkdirAndChownSafe_CreatesAndChownsNewTree verifies the normal path:
// a fresh nested directory is created and the leaf chowned to the target.
func TestMkdirAndChownSafe_CreatesAndChownsNewTree(t *testing.T) {
	requireRoot(t)
	base := t.TempDir()
	leaf := filepath.Join(base, "agentd", "sessions")

	if err := mkdirAndChownSafe(leaf, testUID, testGID); err != nil {
		t.Fatalf("mkdirAndChownSafe: %v", err)
	}
	if got := ownerUID(t, leaf); got != testUID {
		t.Fatalf("leaf owner = %d, want %d", got, testUID)
	}
}

// TestMkdirAndChownSafe_ExistingRealDir chowns an already-present real dir.
func TestMkdirAndChownSafe_ExistingRealDir(t *testing.T) {
	requireRoot(t)
	base := t.TempDir()
	leaf := filepath.Join(base, "agentd")
	if err := os.Mkdir(leaf, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := mkdirAndChownSafe(leaf, testUID, testGID); err != nil {
		t.Fatalf("mkdirAndChownSafe: %v", err)
	}
	if got := ownerUID(t, leaf); got != testUID {
		t.Fatalf("leaf owner = %d, want %d", got, testUID)
	}
}

// TestMkdirAndChownSafe_RefusesLeafSymlinkInWorldWritableDir is the core
// attack case: the leaf itself is a symlink to a victim directory, planted
// in a world-writable parent. The chown must be refused and the victim's
// ownership left untouched.
func TestMkdirAndChownSafe_RefusesLeafSymlinkInWorldWritableDir(t *testing.T) {
	requireRoot(t)
	base := t.TempDir()

	// A world-writable "attacker-controlled" directory (like /tmp).
	ww := filepath.Join(base, "ww")
	if err := os.Mkdir(ww, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(ww, 0o1777); err != nil {
		t.Fatal(err)
	}

	// The victim directory the attacker wants chowned.
	victim := filepath.Join(base, "victim")
	if err := os.Mkdir(victim, 0o755); err != nil {
		t.Fatal(err)
	}

	// Planted symlink: ww/agentd -> victim.
	link := filepath.Join(ww, "agentd")
	if err := os.Symlink(victim, link); err != nil {
		t.Fatal(err)
	}

	err := mkdirAndChownSafe(link, testUID, testGID)
	if err == nil {
		t.Fatal("expected refusal, got nil")
	}
	// Victim must remain root-owned (unchanged).
	if got := ownerUID(t, victim); got != 0 {
		t.Fatalf("victim owner = %d, want 0 (symlink attack succeeded!)", got)
	}
}

// TestMkdirAndChownSafe_RefusesIntermediateSymlinkInWorldWritableDir plants
// the symlink as an intermediate component (ww/agentd -> victim, then asks
// for ww/agentd/sessions). Walking into the symlink must be refused.
func TestMkdirAndChownSafe_RefusesIntermediateSymlinkInWorldWritableDir(t *testing.T) {
	requireRoot(t)
	base := t.TempDir()

	ww := filepath.Join(base, "ww")
	if err := os.Mkdir(ww, 0o1777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(ww, 0o1777); err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(base, "victim")
	if err := os.Mkdir(victim, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, filepath.Join(ww, "agentd")); err != nil {
		t.Fatal(err)
	}

	err := mkdirAndChownSafe(filepath.Join(ww, "agentd", "sessions"), testUID, testGID)
	if err == nil {
		t.Fatal("expected refusal, got nil")
	}
	if got := ownerUID(t, victim); got != 0 {
		t.Fatalf("victim owner = %d, want 0 (symlink attack succeeded!)", got)
	}
	// The attacker's symlink target must not have gained a sessions child.
	if _, statErr := os.Lstat(filepath.Join(victim, "sessions")); statErr == nil {
		t.Fatal("attacker victim gained a 'sessions' dir — walk followed the symlink")
	}
}

// TestMkdirAndChownSafe_FollowsTrustedSymlink verifies the legitimate case
// that must keep working: a symlink whose parent is root-owned and NOT
// world-writable (mirrors /var/run -> /run) is followed, and the leaf under
// the target is created + chowned.
func TestMkdirAndChownSafe_FollowsTrustedSymlink(t *testing.T) {
	requireRoot(t)
	base := t.TempDir()
	// base is created by t.TempDir() as 0700 root-owned — trusted parent.

	realRun := filepath.Join(base, "run")
	if err := os.Mkdir(realRun, 0o755); err != nil {
		t.Fatal(err)
	}
	// Trusted symlink: base/varrun -> base/run, parent (base) is root:root 0700.
	trusted := filepath.Join(base, "varrun")
	if err := os.Symlink(realRun, trusted); err != nil {
		t.Fatal(err)
	}

	leaf := filepath.Join(trusted, "agentd")
	if err := mkdirAndChownSafe(leaf, testUID, testGID); err != nil {
		t.Fatalf("mkdirAndChownSafe on trusted symlink: %v", err)
	}
	// The real directory (through the symlink) should now hold agentd, chowned.
	realLeaf := filepath.Join(realRun, "agentd")
	if got := ownerUID(t, realLeaf); got != testUID {
		t.Fatalf("leaf owner = %d, want %d", got, testUID)
	}
}
