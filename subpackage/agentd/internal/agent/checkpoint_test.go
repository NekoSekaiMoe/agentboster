//go:build linux

package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// hostRef builds a host-FS SandboxRef pointing at sbRoot.
func hostRef(sbRoot string) SandboxRef {
	return SandboxRef{Type: "lxc", HostPath: sbRoot}
}

// withSandboxRoot sets AGENTD_SANDBOX_ROOT to a temp dir for the duration of
// the test and returns that root. The root and a <root>/<name>/workspace tree
// are pre-created so checkpoints can run.
func withSandboxRoot(t *testing.T, name string) string {
	t.Helper()
	root := t.TempDir()
	t.Setenv("AGENTD_SANDBOX_ROOT", root)
	sbRoot := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Join(sbRoot, "workspace"), 0o755); err != nil {
		t.Fatalf("mkdir sandbox workspace: %v", err)
	}
	return sbRoot
}

func TestResolveSandboxRoot_RejectsEmpty(t *testing.T) {
	t.Setenv("AGENTD_SANDBOX_ROOT", t.TempDir())
	if _, err := resolveSandboxRoot("   "); err == nil {
		t.Fatal("expected error for empty sandbox path")
	}
}

func TestResolveSandboxRoot_RejectsEscape(t *testing.T) {
	root := t.TempDir()
	t.Setenv("AGENTD_SANDBOX_ROOT", root)

	for _, in := range []string{
		"../../../etc",
		filepath.Join(root, "..", "..", "etc"),
		"/tmp",
		"/etc/passwd",
	} {
		if _, err := resolveSandboxRoot(in); err == nil {
			t.Fatalf("expected rejection for %q", in)
		}
	}
}

func TestResolveSandboxRoot_AcceptsDescendant(t *testing.T) {
	root := t.TempDir()
	t.Setenv("AGENTD_SANDBOX_ROOT", root)

	sb := filepath.Join(root, "sb-12345678")
	if err := os.MkdirAll(filepath.Join(sb, "workspace"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := resolveSandboxRoot(sb)
	if err != nil {
		t.Fatalf("resolveSandboxRoot: %v", err)
	}
	if got != sb {
		t.Fatalf("expected %q, got %q", sb, got)
	}
}

func TestResolveSandboxRoot_AcceptsRootItself(t *testing.T) {
	root := t.TempDir()
	t.Setenv("AGENTD_SANDBOX_ROOT", root)

	got, err := resolveSandboxRoot(root)
	if err != nil {
		t.Fatalf("resolveSandboxRoot(root): %v", err)
	}
	if got != root {
		t.Fatalf("expected root match %q, got %q", root, got)
	}
}

func TestResolveSandboxRoot_ResolvesSymlink(t *testing.T) {
	root := t.TempDir()
	t.Setenv("AGENTD_SANDBOX_ROOT", root)

	real := filepath.Join(root, "real-12345678")
	if err := os.MkdirAll(filepath.Join(real, "workspace"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link-12345678")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}

	got, err := resolveSandboxRoot(link)
	if err != nil {
		t.Fatalf("resolveSandboxRoot(link): %v", err)
	}
	if got != real {
		t.Fatalf("expected symlink resolution to %q, got %q", real, got)
	}
}

func TestResolveSandboxRoot_RejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	t.Setenv("AGENTD_SANDBOX_ROOT", root)

	outside := t.TempDir()
	link := filepath.Join(root, "escape-12345678")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveSandboxRoot(link); err == nil {
		t.Fatal("expected symlink escape to be rejected")
	}
}

func TestResolveBackend_HostFSTakesHostPath(t *testing.T) {
	sb := withSandboxRoot(t, "sb-12345678")
	b, err := resolveBackend(hostRef(sb), nil)
	if err != nil {
		t.Fatalf("resolveBackend: %v", err)
	}
	if _, ok := b.(*hostGitBackend); !ok {
		t.Fatalf("expected *hostGitBackend, got %T", b)
	}
}

func TestResolveBackend_DockerWithoutManagerFails(t *testing.T) {
	// Docker sandboxes must not silently fall through to the host backend
	// (that would let a container-id-shaped SandboxPath be treated as a host
	// path). Without a manager they must error out.
	_, err := resolveBackend(SandboxRef{Type: "docker", ID: "abcdef12"}, nil)
	if err == nil || !strings.Contains(err.Error(), "manager") {
		t.Fatalf("expected manager error, got %v", err)
	}
}

// TestErrGitUnavailableInContainer_MessageDocumentsFix ensures the sentinel
// error tells operators how to enable checkpoints in container sandboxes.
// The message is part of the public contract (surfaced verbatim via HTTP 503).
func TestErrGitUnavailableInContainer_MessageDocumentsFix(t *testing.T) {
	msg := ErrGitUnavailableInContainer.Error()
	for _, want := range []string{"git", "install", "image"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error message %q missing token %q", msg, want)
		}
	}
}

// TestSanitizeGitValueArg_RejectsFlagLikeValues covers the command-injection
// vector flagged by CodeQL #55: a value that starts with "-" could be parsed
// by git as a flag rather than as a positional argument. Only the explicit
// allowlist of flags we actually use should be accepted.
func TestSanitizeGitValueArg_RejectsFlagLikeValues(t *testing.T) {
	for _, bad := range []string{
		"--upload-pack=evil",
		"-x",
		"-",
	} {
		if _, err := sanitizeGitValueArg(bad); err == nil {
			t.Fatalf("expected rejection for %q", bad)
		}
	}
	for _, ok := range []string{
		"HEAD", "HEAD^{tree}", ".", "refs/agentd-checkpoints/cp-abcdefgh-1",
		"agentd-checkpoint:cp-abcdefgh-1\nsome description",
		"0123456789abcdef0123456789abcdef01234567",
	} {
		if _, err := sanitizeGitValueArg(ok); err != nil {
			t.Fatalf("unexpected rejection for %q: %v", ok, err)
		}
	}
	// Known flags pass even though they start with "-".
	for _, flag := range []string{"-A", "-m", "--allow-empty", "--", "--abbrev-ref"} {
		if _, err := sanitizeGitValueArg(flag); err != nil {
			t.Fatalf("known flag %q should be allowed: %v", flag, err)
		}
	}
}

// TestSanitizeGitValueArgs_RejectsUnknownSubcommand ensures only the git
// subcommands we actually call can be dispatched.
func TestSanitizeGitValueArgs_RejectsUnknownSubcommand(t *testing.T) {
	for _, bad := range []string{"config", "clone", "remote", "daemon"} {
		if _, err := sanitizeGitValueArgs([]string{bad}); err == nil {
			t.Fatalf("expected rejection for subcommand %q", bad)
		}
	}
	for _, ok := range []string{"init", "add", "commit", "rev-parse", "update-ref", "checkout"} {
		if _, err := sanitizeGitValueArgs([]string{ok}); err != nil {
			t.Fatalf("expected acceptance for subcommand %q: %v", ok, err)
		}
	}
}

// TestHostGitBackend_RejectsFlagInjection attempts to drive a flag-shaped
// value through GitRun and asserts the backend refuses to dispatch the
// command at all. This is the concrete mitigation for CodeQL alert #55.
func TestHostGitBackend_RejectsFlagInjection(t *testing.T) {
	b := &hostGitBackend{sandboxRoot: t.TempDir()}
	for _, args := range [][]string{
		{"checkout", "--upload-pack=evil", "--", "."},
		{"update-ref", "refs/x", "-e", "something"},
		{"commit", "-m", "--exec=evil"},
	} {
		if _, err := b.GitRun(args...); err == nil {
			t.Fatalf("expected rejection for args %v", args)
		} else if !strings.Contains(err.Error(), "flag") && !strings.Contains(err.Error(), "subcommand") {
			t.Fatalf("expected flag/subcommand error for %v, got %v", args, err)
		}
	}
}

// TestRestoreCheckpoint_RejectsTamperedHeadSHA writes a checkpoint meta file
// with a non-SHA HeadSHA and asserts Restore refuses to run the checkout.
// This closes the disk-resident attack vector where a tampered meta file
// could inject flags into git checkout.
func TestRestoreCheckpoint_RejectsTamperedHeadSHA(t *testing.T) {
	sb := withSandboxRoot(t, "sb-12345678")

	// Create a legit checkpoint first so the workspace + meta dir exist.
	cp, err := CreateCheckpoint(hostRef(sb), nil, "abcdefgh", "desc")
	if err != nil {
		t.Fatalf("CreateCheckpoint: %v", err)
	}

	// Overwrite the meta with a flag-shaped HeadSHA.
	tampered := cp
	tampered.HeadSHA = "--upload-pack=evil"
	data, _ := json.Marshal(tampered)
	if err := os.WriteFile(filepath.Join(sb, "workspace", checkpointMetaDir, cp.ID+".json"), data, 0o640); err != nil {
		t.Fatal(err)
	}

	err = RestoreCheckpoint(hostRef(sb), nil, cp.ID)
	if err == nil {
		t.Fatal("expected RestoreCheckpoint to reject tampered HeadSHA")
	}
	if !strings.Contains(err.Error(), "invalid head SHA") {
		t.Fatalf("expected SHA validation error, got %v", err)
	}
}

func TestCreateCheckpoint_RejectsBadSessionID(t *testing.T) {
	sb := withSandboxRoot(t, "sb-12345678")

	for _, sid := range []string{"short", "", "with space!", "../../etc", "a-b_c"} {
		if _, err := CreateCheckpoint(hostRef(sb), nil, sid, "d"); err == nil {
			t.Fatalf("expected rejection for sessionID %q", sid)
		}
	}
}

func TestCheckpoint_RoundTrip(t *testing.T) {
	sb := withSandboxRoot(t, "sb-12345678")

	if err := os.WriteFile(filepath.Join(sb, "workspace", "hello.txt"), []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}

	const sessionID = "abcdefgh-session"
	cp, err := CreateCheckpoint(hostRef(sb), nil, sessionID, "initial")
	if err != nil {
		t.Fatalf("CreateCheckpoint: %v", err)
	}
	if !checkpointIDPattern.MatchString(cp.ID) {
		t.Fatalf("checkpoint id %q does not match pattern", cp.ID)
	}

	list, err := ListCheckpoints(hostRef(sb), nil, "")
	if err != nil {
		t.Fatalf("ListCheckpoints: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 checkpoint, got %d", len(list))
	}
	if list[0].ID != cp.ID {
		t.Fatalf("id mismatch: %q vs %q", list[0].ID, cp.ID)
	}

	if err := os.WriteFile(filepath.Join(sb, "workspace", "hello.txt"), []byte("v2"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := RestoreCheckpoint(hostRef(sb), nil, cp.ID); err != nil {
		t.Fatalf("RestoreCheckpoint: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(sb, "workspace", "hello.txt"))
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != "v1" {
		t.Fatalf("restore did not revert content: %q", string(got))
	}
}

func TestCheckpoint_CreateWritesConsistentPaths(t *testing.T) {
	sb := withSandboxRoot(t, "sb-12345678")

	cp, err := CreateCheckpoint(hostRef(sb), nil, "abcdefgh", "desc")
	if err != nil {
		t.Fatalf("CreateCheckpoint: %v", err)
	}

	metaDir := filepath.Join(sb, "workspace", checkpointMetaDir)
	entries, err := os.ReadDir(metaDir)
	if err != nil {
		t.Fatalf("read meta dir: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != cp.ID+".json" {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("expected exactly %q in meta dir, got %v", cp.ID+".json", names)
	}

	doubled := filepath.Join(sb, "workspace", "workspace", checkpointMetaDir)
	if _, err := os.Stat(doubled); err == nil {
		t.Fatalf("double-joined meta dir should not exist: %q", doubled)
	}
}

func TestCheckpoint_RestoreRejectsInvalidID(t *testing.T) {
	sb := withSandboxRoot(t, "sb-12345678")

	for _, id := range []string{"../etc", "cp-abc-xyz", "../../foo", "with space"} {
		if err := RestoreCheckpoint(hostRef(sb), nil, id); err == nil {
			t.Fatalf("expected rejection for id %q", id)
		}
	}
}

func TestCheckpoint_RestoreRefusesOutsideRoot(t *testing.T) {
	root := t.TempDir()
	t.Setenv("AGENTD_SANDBOX_ROOT", root)
	outside := t.TempDir()
	if err := RestoreCheckpoint(hostRef(outside), nil, "cp-abcdefgh-1700000000000"); err == nil {
		t.Fatal("expected rejection for sandbox path outside allowed root")
	} else if !strings.Contains(err.Error(), "outside allowed roots") {
		t.Fatalf("expected 'outside allowed roots' error, got %v", err)
	}
}
