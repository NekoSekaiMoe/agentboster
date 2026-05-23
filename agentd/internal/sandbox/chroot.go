package sandbox

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// ChrootProvider implements SandboxProvider using chroot.
// Provides a persistent filesystem — files survive across commands.
type ChrootProvider struct {
	mu        sync.RWMutex
	baseDir   string // chroot_base from config
	sandboxes map[string]*Sandbox
}

// NewChrootProvider creates a new chroot sandbox provider.
func NewChrootProvider(baseDir string) *ChrootProvider {
	return &ChrootProvider{
		baseDir:   baseDir,
		sandboxes: make(map[string]*Sandbox),
	}
}

// Create creates a chroot-backed sandbox with a minimal Linux filesystem.
func (p *ChrootProvider) Create(spec SandboxSpec) (*Sandbox, error) {
	id := uuid.New().String()[:8]
	rootFS := filepath.Join(p.baseDir, "chroots", id)

	// Create rootfs directory structure
	dirs := []string{
		"workspace", "tmp", "home",
		"bin", "sbin",
		"usr/bin", "usr/sbin", "usr/lib", "usr/lib64",
		"etc", "dev", "proc", "sys",
		"var/tmp", "var/lib",
	}
	for _, dir := range dirs {
		if err := os.MkdirAll(filepath.Join(rootFS, dir), 0o755); err != nil {
			return nil, fmt.Errorf("create chroot dir %s: %w", dir, err)
		}
	}

	// If a base rootfs path is specified, copy it
	if spec.RootFSPath != "" {
		if err := p.copyRootFS(spec.RootFSPath, rootFS); err != nil {
			slog.Warn("failed to copy rootfs, using minimal fs", "error", err)
		}
	} else {
		// Copy essential binaries and libraries from host
		p.copyEssentialBins(rootFS)
	}

	// Create workspace symlink
	workspacePath := filepath.Join(rootFS, "workspace")
	if err := os.MkdirAll(workspacePath, 0o750); err != nil {
		return nil, fmt.Errorf("create workspace: %w", err)
	}

	sb := &Sandbox{
		ID:         id,
		Type:       "chroot",
		Path:       rootFS,
		Status:     "ready",
		Persistent: true, // chroot is always persistent
		CreatedAt:  time.Now(),
	}

	p.mu.Lock()
	p.sandboxes[id] = sb
	p.mu.Unlock()

	slog.Info("chroot sandbox created", "id", id, "path", rootFS)
	return sb, nil
}

// Exec runs a command inside the chroot.
func (p *ChrootProvider) Exec(sandboxID, cmd string, env map[string]string, timeout int) (*ExecResult, error) {
	p.mu.RLock()
	sb, ok := p.sandboxes[sandboxID]
	p.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("sandbox %q not found", sandboxID)
	}

	// Build chroot command
	// Format: chroot <rootfs> /bin/bash -c <cmd>
	chrootCmd := fmt.Sprintf("chroot %s /bin/bash -c %q", sb.Path, cmd)

	var execCmd *exec.Cmd
	if timeout > 0 {
		execCmd = exec.Command("timeout", fmt.Sprintf("%ds", timeout), "bash", "-c", chrootCmd)
	} else {
		execCmd = exec.Command("bash", "-c", chrootCmd)
	}

	// Set environment
	execCmd.Env = os.Environ()
	for k, v := range env {
		execCmd.Env = append(execCmd.Env, k+"="+v)
	}
	execCmd.Env = append(execCmd.Env,
		"HOME=/home",
		"TMPDIR=/tmp",
		"PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
	)

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

// Destroy removes the chroot sandbox (only if not persistent).
func (p *ChrootProvider) Destroy(sandboxID string) error {
	p.mu.Lock()
	sb, ok := p.sandboxes[sandboxID]
	if !ok {
		p.mu.Unlock()
		return fmt.Errorf("sandbox %q not found", sandboxID)
	}
	delete(p.sandboxes, sandboxID)
	p.mu.Unlock()

	if sb.Persistent {
		slog.Info("chroot sandbox preserved (persistent)", "id", sandboxID, "path", sb.Path)
		return nil
	}

	if err := os.RemoveAll(sb.Path); err != nil {
		return fmt.Errorf("remove chroot dir: %w", err)
	}

	slog.Info("chroot sandbox destroyed", "id", sandboxID)
	return nil
}

// Status returns the sandbox status.
func (p *ChrootProvider) Status(sandboxID string) (*Sandbox, error) {
	p.mu.RLock()
	sb, ok := p.sandboxes[sandboxID]
	p.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("sandbox %q not found", sandboxID)
	}
	if _, err := os.Stat(sb.Path); os.IsNotExist(err) {
		sb.Status = "destroyed"
	}
	return sb, nil
}

// copyRootFS copies a base rootfs into the chroot directory.
func (p *ChrootProvider) copyRootFS(src, dst string) error {
	cmd := exec.Command("cp", "-a", src+"/.", dst+"/")
	return cmd.Run()
}

// copyEssentialBins copies essential binaries from the host into the chroot.
func (p *ChrootProvider) copyEssentialBins(rootFS string) {
	essentialBins := []string{
		"/bin/bash", "/bin/sh", "/bin/ls", "/bin/cp", "/bin/mv",
		"/bin/rm", "/bin/mkdir", "/bin/rmdir", "/bin/cat",
		"/bin/echo", "/bin/grep", "/bin/find", "/bin/chmod",
		"/bin/chown", "/bin/touch", "/bin/head", "/bin/tail",
		"/bin/wc", "/bin/sort", "/bin/uniq", "/bin/cut",
		"/bin/sed", "/bin/awk", "/bin/tar", "/bin/gzip",
		"/usr/bin/env", "/usr/bin/whoami", "/usr/bin/id",
		"/usr/bin/git", "/usr/bin/curl", "/usr/bin/wget",
	}

	for _, bin := range essentialBins {
		if _, err := os.Stat(bin); os.IsNotExist(err) {
			continue
		}
		dst := filepath.Join(rootFS, strings.TrimPrefix(bin, "/"))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			continue
		}
		// Try hardlink first, then copy
		if err := os.Link(bin, dst); err != nil {
			exec.Command("cp", "-a", bin, dst).Run()
		}
	}

	// Copy essential shared libraries
	libDirs := []string{"/lib", "/lib64", "/usr/lib", "/usr/lib64"}
	for _, libDir := range libDirs {
		srcDir := libDir
		dstDir := filepath.Join(rootFS, strings.TrimPrefix(libDir, "/"))
		if _, err := os.Stat(srcDir); os.IsNotExist(err) {
			continue
		}
		os.MkdirAll(dstDir, 0o755)
		// Copy .so files
		entries, _ := os.ReadDir(srcDir)
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".so") {
				src := filepath.Join(srcDir, entry.Name())
				dst := filepath.Join(dstDir, entry.Name())
				exec.Command("cp", "-a", src, dst).Run()
			}
		}
	}
}

var _ SandboxProvider = (*ChrootProvider)(nil)
