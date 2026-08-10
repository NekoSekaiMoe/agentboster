//go:build linux
// +build linux

package sandbox

import (
	"os"
	"strings"
	"testing"
)

// TestLXCCreateRejectsInvalidWorkspaceID covers the path-injection guard
// at the top of LXCPersistentProvider.Create: a workspace id containing
// path separators / traversal segments (the value originates from the
// HTTP request body's workspace_id) must be rejected BEFORE any path
// construction — no lxc commands, no filesystem writes under rootfsBase.
func TestLXCCreateRejectsInvalidWorkspaceID(t *testing.T) {
	t.Parallel()
	malicious := []string{
		"../../etc",
		"foo/bar",
		"..",
		"/tmp/evil",
		"not-a-uuid",
		"agentd-lxc-ws-x/../../y",
	}
	for _, wsID := range malicious {
		base := t.TempDir()
		p := NewLXCPersistentProvider(base, "", "", 1)
		_, err := p.Create(SandboxSpec{WorkspaceID: wsID})
		if err == nil {
			t.Errorf("Create(WorkspaceID=%q) succeeded; want rejection", wsID)
			continue
		}
		if !strings.Contains(err.Error(), "invalid workspace id") {
			t.Errorf("Create(WorkspaceID=%q) error = %v; want 'invalid workspace id'", wsID, err)
		}
		entries, readErr := os.ReadDir(base)
		if readErr != nil {
			t.Fatalf("read rootfsBase: %v", readErr)
		}
		if len(entries) != 0 {
			t.Errorf("Create(WorkspaceID=%q) touched the filesystem before rejection: %v", wsID, entries)
		}
	}
}

// TestNormalizeWorkspaceID covers the canonicalization helper: uppercase
// and non-canonical-but-parseable UUID forms normalize to lowercase
// canonical; anything that isn't a UUID is rejected.
func TestNormalizeWorkspaceID(t *testing.T) {
	t.Parallel()

	upper := "A1B2C3D4-E5F6-7890-ABCD-EF1234567890"
	got, err := normalizeWorkspaceID(upper)
	if err != nil {
		t.Fatalf("normalizeWorkspaceID(%q): %v", upper, err)
	}
	if want := strings.ToLower(upper); got != want {
		t.Errorf("normalizeWorkspaceID(%q) = %q; want %q", upper, got, want)
	}

	// Hyphenless hex is parseable but non-canonical → normalized with hyphens.
	if got, err := normalizeWorkspaceID("a1b2c3d4e5f67890abcdef1234567890"); err != nil {
		t.Fatalf("normalizeWorkspaceID(hyphenless): %v", err)
	} else if got != "a1b2c3d4-e5f6-7890-abcd-ef1234567890" {
		t.Errorf("normalizeWorkspaceID(hyphenless) = %q; want canonical", got)
	}

	// Canonical form round-trips unchanged.
	if again, err := normalizeWorkspaceID(got); err != nil || again != got {
		t.Errorf("canonical id changed: %q → %q (err=%v)", got, again, err)
	}

	for _, bad := range []string{"", "../../etc", "foo/bar", "..", "zzzz", "a1b2c3d4-e5f6-7890-abcd-ef123456789"} {
		if _, err := normalizeWorkspaceID(bad); err == nil {
			t.Errorf("normalizeWorkspaceID(%q) succeeded; want error", bad)
		}
	}
}
