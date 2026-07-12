//go:build linux

package agent

import (
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

const checkpointRefBase = "refs/agentd-checkpoints"
const defaultSandboxRoot = "/var/lib/agentd/sandboxes"

var checkpointIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func safeSandboxRoot() string {
	if v := strings.TrimSpace(os.Getenv("AGENTD_SANDBOX_ROOT")); v != "" {
		return v
	}
	return defaultSandboxRoot
}

func resolveWorkspacePath(sandboxPath string) (string, error) {
	if strings.TrimSpace(sandboxPath) == "" {
		return "", errors.New("sandbox path is required")
	}

	rootAbs, err := filepath.Abs(filepath.Clean(safeSandboxRoot()))
	if err != nil {
		return "", fmt.Errorf("resolve sandbox root: %w", err)
	}

	sandboxAbs, err := filepath.Abs(filepath.Clean(sandboxPath))
	if err != nil {
		return "", fmt.Errorf("resolve sandbox path: %w", err)
	}

	rel, err := filepath.Rel(rootAbs, sandboxAbs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", fmt.Errorf("sandbox path is outside allowed root")
	}

	return filepath.Join(sandboxAbs, "workspace"), nil
}

func gitCmd(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// CreateCheckpoint creates a git snapshot of the current workspace state.
func CreateCheckpoint(sandboxPath, sessionID, description string) (*CheckpointData, error) {
	resolvedSandboxPath, err := resolveWorkspacePath(sandboxPath)
	if err != nil {
		return nil, err
	}

	sessionID = strings.TrimSpace(sessionID)
	if len(sessionID) < 8 {
		return nil, errors.New("session id must be at least 8 characters")
	}
	if !checkpointIDPattern.MatchString(sessionID) {
		return nil, errors.New("session id contains invalid characters")
	}

	workDir := filepath.Join(resolvedSandboxPath, "workspace")
	if _, err := os.Stat(filepath.Join(workDir, ".git")); os.IsNotExist(err) {
		if _, initErr := gitCmd(workDir, "init"); initErr != nil {
			return nil, fmt.Errorf("git init: %w", initErr)
		}
	}

	if _, err := gitCmd(workDir, "add", "-A"); err != nil {
		return nil, fmt.Errorf("git add: %w", err)
	}

	ts := time.Now()
	id := fmt.Sprintf("cp-%s-%d", sessionID[:8], ts.UnixMilli())
	msg := fmt.Sprintf("agentd-checkpoint:%s\n%s", id, description)

	env := os.Environ()
	env = append(env,
		"GIT_AUTHOR_NAME=agentd",
		"GIT_AUTHOR_EMAIL=agentd@local",
		"GIT_COMMITTER_NAME=agentd",
		"GIT_COMMITTER_EMAIL=agentd@local",
	)

	commitCmd := exec.Command("git", "commit", "--allow-empty", "-m", msg)
	commitCmd.Dir = workDir
	commitCmd.Env = env
	if out, err := commitCmd.CombinedOutput(); err != nil {
		slog.Debug("git commit output", "output", string(out))
		return nil, fmt.Errorf("git commit: %w", err)
	}

	headSHA, _ := gitCmd(workDir, "rev-parse", "HEAD")
	treeSHA, _ := gitCmd(workDir, "rev-parse", "HEAD^{tree}")
	branch, _ := gitCmd(workDir, "rev-parse", "--abbrev-ref", "HEAD")

	ref := fmt.Sprintf("%s/%s", checkpointRefBase, id)
	if _, err := gitCmd(workDir, "update-ref", ref, headSHA); err != nil {
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

	metaPath := filepath.Join(resolvedSandboxPath, "workspace", ".agentd-checkpoints")
	os.MkdirAll(metaPath, 0o755)
	data, _ := json.MarshalIndent(cp, "", "  ")
	os.WriteFile(filepath.Join(metaPath, id+".json"), data, 0o640)

	slog.Info("checkpoint created", "id", id, "head", headSHA[:8], "description", description)
	return cp, nil
}

// ListCheckpoints returns all checkpoints for a session.
func ListCheckpoints(sandboxPath, sessionID string) ([]CheckpointData, error) {
	workDir, err := resolveWorkspacePath(sandboxPath)
	if err != nil {
		return nil, err
	}

	metaPath := filepath.Join(workDir, ".agentd-checkpoints")
	entries, err := os.ReadDir(metaPath)
	if err != nil {
		if os.IsNotExist(err) {
			return []CheckpointData{}, nil
		}
		return nil, err
	}

	var checkpoints []CheckpointData
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(metaPath, e.Name()))
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
func RestoreCheckpoint(sandboxPath, checkpointID string) error {
	if !checkpointIDPattern.MatchString(checkpointID) {
		return fmt.Errorf("invalid checkpoint id")
	}

	workDir, err := resolveWorkspacePath(sandboxPath)
	if err != nil {
		return err
	}

	metaPath := filepath.Join(workDir, ".agentd-checkpoints", checkpointID+".json")
	data, err := os.ReadFile(metaPath)
	if err != nil {
		return fmt.Errorf("checkpoint %s not found", checkpointID)
	}

	var cp CheckpointData
	if err := json.Unmarshal(data, &cp); err != nil {
		return fmt.Errorf("invalid checkpoint data: %w", err)
	}

	if _, err := gitCmd(workDir, "checkout", cp.HeadSHA, "--", "."); err != nil {
		return fmt.Errorf("git checkout: %w", err)
	}

	slog.Info("checkpoint restored", "id", checkpointID, "head", cp.HeadSHA[:8])
	return nil
}
