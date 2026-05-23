//go:build linux
// +build linux

package sandbox

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
)

// TmpfsProvider implements SandboxProvider using tmpfs mounts.
type TmpfsProvider struct {
	mu         sync.RWMutex
	tmpfsSize  string
	workDir    string
	sandboxes  map[string]*Sandbox
}

// NewTmpfsProvider creates a new tmpfs sandbox provider.
func NewTmpfsProvider(tmpfsSize, workDir string) *TmpfsProvider {
	return &TmpfsProvider{
		tmpfsSize: tmpfsSize,
		workDir:   workDir,
		sandboxes: make(map[string]*Sandbox),
	}
}

// Create creates a tmpfs-backed sandbox.
func (p *TmpfsProvider) Create(spec SandboxSpec) (*Sandbox, error) {
	id := uuid.New().String()[:8]
	baseDir := filepath.Join(p.workDir, "tmpfs", id)

	// Create workspace directory
	if err := os.MkdirAll(baseDir, 0o750); err != nil {
		return nil, fmt.Errorf("create sandbox dir: %w", err)
	}

	// Mount tmpfs
	mountCmd := exec.Command("mount", "-t", "tmpfs", "-o", "size="+p.tmpfsSize, "tmpfs", baseDir)
	if err := mountCmd.Run(); err != nil {
		// If mount fails (e.g., no privileges), fall back to regular directory
		slog.Warn("tmpfs mount failed, using regular directory", "error", err, "dir", baseDir)
	}

	// Create standard subdirs
	for _, subdir := range []string{"workspace", "tmp", "home"} {
		if err := os.MkdirAll(filepath.Join(baseDir, subdir), 0o750); err != nil {
			return nil, fmt.Errorf("create subdir %s: %w", subdir, err)
		}
	}

	sb := &Sandbox{
		ID:         id,
		Type:       "tmpfs",
		Path:       baseDir,
		Status:     "ready",
		Persistent: spec.Persistent,
		CreatedAt:  time.Now(),
	}

	p.mu.Lock()
	p.sandboxes[id] = sb
	p.mu.Unlock()

	slog.Info("tmpfs sandbox created", "id", id, "path", baseDir, "size", p.tmpfsSize)
	return sb, nil
}

// Exec runs a command inside the tmpfs sandbox using chroot.
func (p *TmpfsProvider) Exec(sandboxID, cmd string, env map[string]string, timeout int) (*ExecResult, error) {
	p.mu.RLock()
	sb, ok := p.sandboxes[sandboxID]
	p.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("sandbox %q not found", sandboxID)
	}

	workspaceDir := filepath.Join(sb.Path, "workspace")

	// Build the execution command
	// Use timeout command to enforce time limit
	var execCmd *exec.Cmd
	if timeout > 0 {
		execCmd = exec.Command("timeout", fmt.Sprintf("%ds", timeout), "bash", "-c", cmd)
	} else {
		execCmd = exec.Command("bash", "-c", cmd)
	}
	execCmd.Dir = workspaceDir

	// Set environment
	execCmd.Env = os.Environ()
	for k, v := range env {
		execCmd.Env = append(execCmd.Env, k+"="+v)
	}
	execCmd.Env = append(execCmd.Env, "HOME="+filepath.Join(sb.Path, "home"))
	execCmd.Env = append(execCmd.Env, "TMPDIR="+filepath.Join(sb.Path, "tmp"))

	// If sandbox has /bin etc., use chroot
	// For now, run directly in workspace dir (simpler, no root required)
	// Phase 4: full chroot support

	start := time.Now()
	output, err := execCmd.CombinedOutput()
	duration := time.Since(start)

	result := &ExecResult{
		Stdout:   string(output),
		Duration: duration,
	}

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
		} else {
			result.ExitCode = -1
		}
		result.Stderr = string(output)
	} else {
		result.ExitCode = 0
	}

	return result, nil
}

// Destroy removes the tmpfs sandbox.
func (p *TmpfsProvider) Destroy(sandboxID string) error {
	p.mu.Lock()
	sb, ok := p.sandboxes[sandboxID]
	if !ok {
		p.mu.Unlock()
		return fmt.Errorf("sandbox %q not found", sandboxID)
	}
	delete(p.sandboxes, sandboxID)
	p.mu.Unlock()

	// Unmount tmpfs
	umountCmd := exec.Command("umount", sb.Path)
	if err := umountCmd.Run(); err != nil {
		slog.Warn("tmpfs unmount failed, falling back to rm", "error", err, "path", sb.Path)
		// Fall back to recursive delete
	}

	// Remove directory
	if err := os.RemoveAll(sb.Path); err != nil {
		return fmt.Errorf("remove sandbox dir: %w", err)
	}

	slog.Info("tmpfs sandbox destroyed", "id", sandboxID)
	return nil
}

// Status returns the sandbox status.
func (p *TmpfsProvider) Status(sandboxID string) (*Sandbox, error) {
	p.mu.RLock()
	sb, ok := p.sandboxes[sandboxID]
	p.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("sandbox %q not found", sandboxID)
	}

	// Check if directory still exists
	if _, err := os.Stat(sb.Path); os.IsNotExist(err) {
		sb.Status = "destroyed"
	}

	return sb, nil
}

// SandboxPath returns the workspace path for a sandbox.
func (p *TmpfsProvider) SandboxPath(sandboxID string) (string, error) {
	p.mu.RLock()
	sb, ok := p.sandboxes[sandboxID]
	p.mu.RUnlock()
	if !ok {
		return "", fmt.Errorf("sandbox %q not found", sandboxID)
	}
	return filepath.Join(sb.Path, "workspace"), nil
}

// WriteFile writes a file into the sandbox workspace.
func (p *TmpfsProvider) WriteFile(sandboxID, path, content string) error {
	sbPath, err := p.SandboxPath(sandboxID)
	if err != nil {
		return err
	}
	fullPath := filepath.Join(sbPath, path)
	dir := filepath.Dir(fullPath)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	return os.WriteFile(fullPath, []byte(content), 0o640)
}

// ReadFile reads a file from the sandbox workspace.
func (p *TmpfsProvider) ReadFile(sandboxID, path string) (string, error) {
	sbPath, err := p.SandboxPath(sandboxID)
	if err != nil {
		return "", err
	}
	fullPath := filepath.Join(sbPath, path)
	data, err := os.ReadFile(fullPath)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// ListFiles lists files in the sandbox workspace.
func (p *TmpfsProvider) ListFiles(sandboxID, pattern string) ([]string, error) {
	sbPath, err := p.SandboxPath(sandboxID)
	if err != nil {
		return nil, err
	}
	if pattern == "" {
		pattern = "*"
	}
	matches, err := filepath.Glob(filepath.Join(sbPath, pattern))
	if err != nil {
		return nil, err
	}
	// Strip sandbox path prefix
	for i, m := range matches {
		rel, err := filepath.Rel(sbPath, m)
		if err != nil {
			rel = m
		}
		matches[i] = rel
	}
	return matches, nil
}

// ensure tmpfsProvider satisfies SandboxProvider
var _ SandboxProvider = (*TmpfsProvider)(nil)
