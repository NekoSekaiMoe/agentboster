//go:build linux

package security

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseGroupIDsIncludesPrimaryAndSupplementaryGroups(t *testing.T) {
	groupIDs, err := parseGroupIDs("1001 998 1001 999\n", 1001)
	if err != nil {
		t.Fatalf("parseGroupIDs: %v", err)
	}

	want := []int{1001, 998, 999}
	if len(groupIDs) != len(want) {
		t.Fatalf("expected %v, got %v", want, groupIDs)
	}
	for i := range want {
		if groupIDs[i] != want[i] {
			t.Fatalf("expected %v, got %v", want, groupIDs)
		}
	}
}

func TestParseGroupIDsRejectsInvalidGroupID(t *testing.T) {
	if _, err := parseGroupIDs("1001 docker\n", 1001); err == nil {
		t.Fatal("expected invalid group id error")
	}
}

// TestPrepareRuntimeOwnershipNoopWhenRoot verifies that PrepareRuntimeOwnership
// does nothing (no dir creation, no user lookup) when no privilege drop will
// happen. This is the path exercised in unprivileged CI, where the chowning
// branch cannot run. A root/empty run_as_user means the daemon keeps running as
// root and can already manage its own runtime dirs.
func TestPrepareRuntimeOwnershipNoopWhenRoot(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "should-not-be-created")
	for _, user := range []string{"", "root"} {
		if err := PrepareRuntimeOwnership(user, dir); err != nil {
			t.Fatalf("PrepareRuntimeOwnership(%q) = %v, want nil", user, err)
		}
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Fatalf("PrepareRuntimeOwnership(%q) created %q; expected no-op", user, dir)
		}
	}
}
