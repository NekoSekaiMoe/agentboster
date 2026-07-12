//go:build linux

package agent

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
)

// CheckpointData describes a git-based snapshot of the sandbox workspace.
type CheckpointData struct {
	ID          string `json:"id"`
	SessionID   string `json:"session_id"`
	Description string `json:"description,omitempty"`
	Branch      string `json:"branch"`
	HeadSHA     string `json:"head_sha"`
	TreeSHA     string `json:"tree_sha"`
	Timestamp   int64  `json:"timestamp"`
}

const (
	checkpointRefBase   = "refs/agentd-checkpoints"
	checkpointMetaDir   = ".agentd-checkpoints"
	checkpointShortIDLn = 8
	// workspaceDir matches the in-sandbox workspace directory name used by
	// every provider (see sandbox.WorkspaceDir). Both the host-FS path
	// (<root>/workspace) and the in-container path (/workspace) use it.
	checkpointWorkspaceDir = "workspace"
)

// allowedSandboxRoots are the host prefixes under which an LXC sandbox rootfs
// (or any host-backed sandbox workspace) may legitimately live. A checkpoint
// target must resolve — after symlink evaluation — to one of these roots or a
// strict descendant of one.
var allowedSandboxRoots = []string{
	"/var/lib/agentd/sandboxes",
	"/var/lib/agentd/lxc",
}

// sessionIDPattern constrains session ids used to derive checkpoint ids.
var sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)

// checkpointIDPattern matches the on-disk id format `cp-<prefix>-<ts>`.
var checkpointIDPattern = regexp.MustCompile(`^cp-[A-Za-z0-9_-]{8,128}-[0-9]+$`)

// safeMetaFileNamePattern restricts file names we are willing to write/read
// under the checkpoint meta dir.
var safeMetaFileNamePattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// base64StdEncoding is an alias for base64.StdEncoding, used by the container
// backend to stream bytes through Manager.Exec (which has no stdin channel).
var base64StdEncoding = base64.StdEncoding

// SandboxRef identifies a sandbox for checkpoint purposes. Docker-style
// sandboxes (no host workspace) are executed in-container via sbMgr; host-FS
// sandboxes (LXC) resolve HostPath against the allowed roots.
type SandboxRef struct {
	Type string
	// ID is the sandbox ID used with sandbox.Manager (required for in-container
	// execution; empty for pure host-FS callers that already supply HostPath).
	ID string
	// HostPath is the sandbox root on the host filesystem (LXC rootfs). Empty
	// for docker-style sandboxes, which have no host workspace.
	HostPath string
}

// extraSandboxRootFromEnv returns an operator-configured extra allowed root.
func extraSandboxRootFromEnv() string {
	return strings.TrimSpace(os.Getenv("AGENTD_SANDBOX_ROOT"))
}

func isAbsOrRelEscape(rel string) bool {
	if rel == "." {
		return false
	}
	if filepath.IsAbs(rel) {
		return true
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return true
	}
	return false
}

// resolveSandboxRoot validates that sandboxPath points to a sandbox root that
// lives under one of the configured/known agentd roots, and returns the
// canonical (symlink-resolved) absolute path of that root.
func resolveSandboxRoot(sandboxPath string) (string, error) {
	if strings.TrimSpace(sandboxPath) == "" {
		return "", errors.New("sandbox path is required")
	}

	abs, err := filepath.Abs(filepath.Clean(sandboxPath))
	if err != nil {
		return "", fmt.Errorf("resolve sandbox path: %w", err)
	}

	// EvalSymlinks resolves intermediate symlinks; a missing target is fine
	// (some checkpoints run before the workspace dir exists), so fall back to
	// the cleaned absolute path when the FS lookup fails.
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		real = abs
	}

	roots := make([]string, 0, len(allowedSandboxRoots)+1)
	roots = append(roots, allowedSandboxRoots...)
	if extra := extraSandboxRootFromEnv(); extra != "" {
		roots = append(roots, extra)
	}

	for _, raw := range roots {
		rootClean, rerr := filepath.Abs(filepath.Clean(raw))
		if rerr != nil {
			continue
		}
		if rr, eerr := filepath.EvalSymlinks(rootClean); eerr == nil {
			rootClean = rr
		}
		if real == rootClean {
			return real, nil
		}
		rel, relErr := filepath.Rel(rootClean, real)
		if relErr != nil {
			continue
		}
		if isAbsOrRelEscape(rel) {
			continue
		}
		return real, nil
	}

	return "", fmt.Errorf("sandbox path %q is outside allowed roots", sandboxPath)
}

// ── Backend abstraction ─────────────────────────────────────────────

// checkpointBackend abstracts where git runs. Two implementations:
//   - hostGitBackend: runs git on the host against <root>/workspace (LXC and
//     any host-backed sandbox).
//   - containerGitBackend: runs git inside the sandbox via sandbox.Manager
//     (docker / docker-strict), where the workspace lives at /workspace.
type checkpointBackend interface {
	// Run executes a git command in the workspace dir and returns trimmed
	// stdout + error. Non-zero exit is reported via error.
	GitRun(args ...string) (string, error)
	// RunCommit runs git commit with a custom author/committer env.
	GitCommit(args ...string) (string, error)
	// WorkspaceExists reports whether the workspace directory exists.
	WorkspaceExists() bool
	// EnsureWorkspace ensures the workspace dir + meta dir exist.
	EnsureWorkspace() error
	// WriteMeta writes a file under the workspace's checkpoint meta dir.
	WriteMeta(name string, data []byte) error
	// ReadMeta reads a file under the workspace's checkpoint meta dir.
	ReadMeta(name string) ([]byte, error)
	// ListMeta lists file names in the checkpoint meta dir (names only).
	ListMeta() ([]string, error)
}

// hostGitBackend runs git on the host filesystem.
type hostGitBackend struct {
	sandboxRoot string
}

func (b *hostGitBackend) workspace() string { return filepath.Join(b.sandboxRoot, checkpointWorkspaceDir) }
func (b *hostGitBackend) metaDir() string   { return filepath.Join(b.workspace(), checkpointMetaDir) }

func (b *hostGitBackend) GitRun(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = b.workspace()
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func (b *hostGitBackend) GitCommit(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = b.workspace()
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=agentd",
		"GIT_AUTHOR_EMAIL=agentd@local",
		"GIT_COMMITTER_NAME=agentd",
		"GIT_COMMITTER_EMAIL=agentd@local",
	)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func (b *hostGitBackend) WorkspaceExists() bool {
	info, err := os.Stat(b.workspace())
	return err == nil && info.IsDir()
}

func (b *hostGitBackend) EnsureWorkspace() error {
	if err := os.MkdirAll(b.workspace(), 0o755); err != nil {
		return fmt.Errorf("create workspace: %w", err)
	}
	if err := os.MkdirAll(b.metaDir(), 0o755); err != nil {
		return fmt.Errorf("create meta dir: %w", err)
	}
	return nil
}

func (b *hostGitBackend) WriteMeta(name string, data []byte) error {
	if err := os.MkdirAll(b.metaDir(), 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(b.metaDir(), name), data, 0o640)
}

func (b *hostGitBackend) ReadMeta(name string) ([]byte, error) {
	return os.ReadFile(filepath.Join(b.metaDir(), name))
}

func (b *hostGitBackend) ListMeta() ([]string, error) {
	entries, err := os.ReadDir(b.metaDir())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			out = append(out, e.Name())
		}
	}
	return out, nil
}

// containerGitBackend runs git inside the sandbox container via Manager.Exec.
// Workdir is fixed at /workspace; meta files live under
// /workspace/.agentd-checkpoints.
type containerGitBackend struct {
	sbMgr     *sandbox.Manager
	sandboxID string
}

const containerWorkspace = "/workspace"
const containerMetaDir = "/workspace/" + checkpointMetaDir
const containerGitTimeoutSec = 60

// quoteShellArg single-quotes a value for safe inclusion in `sh -c`.
func quoteShellArg(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func (b *containerGitBackend) runSh(cmd string) (string, error) {
	if b.sbMgr == nil {
		return "", errors.New("sandbox manager not available for in-container checkpoint")
	}
	res, err := b.sbMgr.Exec(b.sandboxID, cmd, nil, containerGitTimeoutSec)
	if err != nil {
		return "", err
	}
	combined := res.Stdout
	if res.ExitCode != 0 {
		if combined == "" {
			combined = res.Stderr
		}
		return combined, fmt.Errorf("git exit %d: %s", res.ExitCode, combined)
	}
	return strings.TrimRight(combined, "\n"), nil
}

func (b *containerGitBackend) GitRun(args ...string) (string, error) {
	// Quote each arg; git is invoked via `sh -c` so the workspace CWD applies.
	parts := make([]string, 0, len(args)+2)
	parts = append(parts, "git")
	for _, a := range args {
		parts = append(parts, quoteShellArg(a))
	}
	return b.runSh(strings.Join(parts, " "))
}

func (b *containerGitBackend) GitCommit(args ...string) (string, error) {
	// git requires env vars to be set on the same command line.
	prefix := "GIT_AUTHOR_NAME=agentd GIT_AUTHOR_EMAIL=agentd@local GIT_COMMITTER_NAME=agentd GIT_COMMITTER_EMAIL=agentd@local "
	parts := make([]string, 0, len(args)+2)
	parts = append(parts, "git")
	for _, a := range args {
		parts = append(parts, quoteShellArg(a))
	}
	return b.runSh(prefix + strings.Join(parts, " "))
}

func (b *containerGitBackend) WorkspaceExists() bool {
	_, err := b.runSh("test -d " + containerWorkspace)
	return err == nil
}

func (b *containerGitBackend) EnsureWorkspace() error {
	_, err := b.runSh("mkdir -p " + containerWorkspace + " " + containerMetaDir)
	return err
}

func (b *containerGitBackend) WriteMeta(name string, data []byte) error {
	if !safeMetaFileNamePattern.MatchString(name) {
		return fmt.Errorf("invalid meta file name %q", name)
	}
	if err := b.EnsureWorkspace(); err != nil {
		return err
	}
	// Manager.Exec has no stdin channel, so base64-encode the payload and
	// decode it inside the container. This sidesteps all shell-quoting issues.
	enc := base64StdEncoding.EncodeToString(data)
	target := containerMetaDir + "/" + name
	cmd := fmt.Sprintf("printf %%s %q | base64 -d > %s", enc, target)
	_, err := b.runSh(cmd)
	return err
}

func (b *containerGitBackend) ReadMeta(name string) ([]byte, error) {
	if !safeMetaFileNamePattern.MatchString(name) {
		return nil, fmt.Errorf("invalid meta file name %q", name)
	}
	out, err := b.runSh(fmt.Sprintf("cat %s/%s", containerMetaDir, name))
	if err != nil {
		return nil, err
	}
	return []byte(out), nil
}

func (b *containerGitBackend) ListMeta() ([]string, error) {
	out, err := b.runSh(fmt.Sprintf("ls -1A %s 2>/dev/null || true", containerMetaDir))
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(out) == "" {
		return nil, nil
	}
	return strings.Split(strings.TrimRight(out, "\n"), "\n"), nil
}

// resolveBackend picks the right backend for a SandboxRef.
//
//   - Docker-style sandboxes (sb.Type docker/docker-strict) require execution
//     inside the container, since their workspace is not on the host FS.
//   - Everything else (LXC, or direct host-FS callers) runs git on the host
//     against the validated sandbox root.
func resolveBackend(ref SandboxRef, sbMgr *sandbox.Manager) (checkpointBackend, error) {
	if sandbox.IsDockerSandbox(ref.Type) {
		if sbMgr == nil {
			return nil, errors.New("docker checkpoint requires a sandbox manager")
		}
		if ref.ID == "" {
			return nil, errors.New("docker checkpoint requires a sandbox id")
		}
		return &containerGitBackend{sbMgr: sbMgr, sandboxID: ref.ID}, nil
	}
	root, err := resolveSandboxRoot(ref.HostPath)
	if err != nil {
		return nil, err
	}
	return &hostGitBackend{sandboxRoot: root}, nil
}

// CreateCheckpoint creates a git snapshot of the current workspace state.
func CreateCheckpoint(ref SandboxRef, sbMgr *sandbox.Manager, sessionID, description string) (*CheckpointData, error) {
	backend, err := resolveBackend(ref, sbMgr)
	if err != nil {
		return nil, err
	}

	sessionID = strings.TrimSpace(sessionID)
	if !sessionIDPattern.MatchString(sessionID) {
		return nil, fmt.Errorf("invalid session id: must be 8-128 chars of [A-Za-z0-9_-]")
	}

	if err := backend.EnsureWorkspace(); err != nil {
		return nil, fmt.Errorf("ensure workspace: %w", err)
	}

	if _, err := backend.GitRun("init"); err != nil {
		// `git init` on an existing repo is a no-op; only fail on real errors.
		if !strings.Contains(err.Error(), "reinitialized") {
			return nil, fmt.Errorf("git init: %w", err)
		}
	}

	if _, err := backend.GitRun("add", "-A"); err != nil {
		return nil, fmt.Errorf("git add: %w", err)
	}

	ts := time.Now()
	id := fmt.Sprintf("cp-%s-%d", sessionID[:checkpointShortIDLn], ts.UnixMilli())
	msg := fmt.Sprintf("agentd-checkpoint:%s\n%s", id, description)

	if out, err := backend.GitCommit("commit", "--allow-empty", "-m", msg); err != nil {
		slog.Debug("git commit output", "output", out)
		return nil, fmt.Errorf("git commit: %w", err)
	}

	headSHA, _ := backend.GitRun("rev-parse", "HEAD")
	treeSHA, _ := backend.GitRun("rev-parse", "HEAD^{tree}")
	branch, _ := backend.GitRun("rev-parse", "--abbrev-ref", "HEAD")

	refName := fmt.Sprintf("%s/%s", checkpointRefBase, id)
	if _, err := backend.GitRun("update-ref", refName, headSHA); err != nil {
		slog.Warn("failed to create checkpoint ref", "error", err)
	}

	cp := &CheckpointData{
		ID:          id,
		SessionID:   sessionID,
		Description: description,
		Branch:      branch,
		HeadSHA:     headSHA,
		TreeSHA:     treeSHA,
		Timestamp:   ts.UnixMilli(),
	}

	data, _ := json.MarshalIndent(cp, "", "  ")
	if err := backend.WriteMeta(id+".json", data); err != nil {
		return nil, fmt.Errorf("write checkpoint meta: %w", err)
	}

	slog.Info("checkpoint created", "id", id, "head", shortSHA(headSHA), "description", description, "sandbox_type", ref.Type)
	return cp, nil
}

// ListCheckpoints returns all checkpoints for a session.
func ListCheckpoints(ref SandboxRef, sbMgr *sandbox.Manager, sessionID string) ([]CheckpointData, error) {
	backend, err := resolveBackend(ref, sbMgr)
	if err != nil {
		return nil, err
	}

	names, err := backend.ListMeta()
	if err != nil || names == nil {
		return []CheckpointData{}, nil
	}

	checkpoints := make([]CheckpointData, 0)
	for _, name := range names {
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		id := strings.TrimSuffix(name, ".json")
		if !checkpointIDPattern.MatchString(id) {
			continue
		}
		data, err := backend.ReadMeta(name)
		if err != nil {
			continue
		}
		var cp CheckpointData
		if err := json.Unmarshal(data, &cp); err != nil {
			continue
		}
		if sessionID != "" && cp.SessionID != sessionID {
			continue
		}
		checkpoints = append(checkpoints, cp)
	}
	return checkpoints, nil
}

// RestoreCheckpoint restores the workspace to a checkpoint's state.
func RestoreCheckpoint(ref SandboxRef, sbMgr *sandbox.Manager, checkpointID string) error {
	if !checkpointIDPattern.MatchString(checkpointID) {
		return fmt.Errorf("invalid checkpoint id")
	}

	backend, err := resolveBackend(ref, sbMgr)
	if err != nil {
		return err
	}

	data, err := backend.ReadMeta(checkpointID + ".json")
	if err != nil {
		return fmt.Errorf("checkpoint %s not found", checkpointID)
	}

	var cp CheckpointData
	if err := json.Unmarshal(data, &cp); err != nil {
		return fmt.Errorf("invalid checkpoint data: %w", err)
	}

	if _, err := backend.GitRun("checkout", cp.HeadSHA, "--", "."); err != nil {
		return fmt.Errorf("git checkout: %w", err)
	}

	slog.Info("checkpoint restored", "id", checkpointID, "head", shortSHA(cp.HeadSHA))
	return nil
}

func shortSHA(sha string) string {
	if len(sha) >= checkpointShortIDLn {
		return sha[:checkpointShortIDLn]
	}
	return sha
}
