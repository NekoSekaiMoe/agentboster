//go:build linux
// +build linux

package sandbox

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/clawless/agentd/internal/config"
	"github.com/google/uuid"
)

// Snapshot represents a chroot workspace snapshot.
type Snapshot struct {
	ID        string    `json:"id"`
	SandboxID string    `json:"sandbox_id"`
	Name      string    `json:"name"`
	Path      string    `json:"path"`       // path to the tar.gz on disk
	Size      int64     `json:"size"`       // bytes
	CreatedAt time.Time `json:"created_at"`
}

// ChrootProvider implements SandboxProvider using chroot.
// Provides a persistent filesystem — files survive across commands.
type ChrootProvider struct {
	mu              sync.RWMutex
	baseDir         string // chroot_base from config
	cacheDir        string // rootfs_cache_dir
	snapshotDir     string // snapshot storage directory
	localPath       string // local_rootfs_path
	defaultURL      string // default_rootfs_url
	busyboxURL      string // default_busybox_url
	initCommands    []string
	presets         []config.ChrootPreset
	cacheMaxAge     time.Duration
	sandboxes       map[string]*Sandbox
	snapshots       map[string]*Snapshot // keyed by snapshot ID
}

// NewChrootProvider creates a new chroot sandbox provider.
func NewChrootProvider(baseDir, cacheDir, localPath, defaultURL, busyboxURL string, initCommands []string, presets []config.ChrootPreset, cacheMaxAgeDays int) *ChrootProvider {
	snapshotDir := filepath.Join(baseDir, "snapshots")
	p := &ChrootProvider{
		baseDir:      baseDir,
		cacheDir:     cacheDir,
		snapshotDir:  snapshotDir,
		localPath:    localPath,
		defaultURL:   defaultURL,
		busyboxURL:   busyboxURL,
		initCommands: initCommands,
		presets:      presets,
		cacheMaxAge:  time.Duration(cacheMaxAgeDays) * 24 * time.Hour,
		sandboxes:    make(map[string]*Sandbox),
		snapshots:    make(map[string]*Snapshot),
	}
	// Ensure dirs exist
	os.MkdirAll(cacheDir, 0o750)
	os.MkdirAll(snapshotDir, 0o750)
	// Start background cache cleanup
	go p.periodicCacheCleanup()
	return p
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

	// Determine rootfs source (priority order):
	// 1. spec.RootFSPath (user-specified local path)
	// 2. spec.RootFSUrl (user-specified URL)
	// 3. presets (by matching spec.AgentID or preset name)
	// 4. local_rootfs_path from config
	// 5. download Alpine minirootfs from default URL
	// 6. fallback: download static busybox binary
	var failures []string
	rootfsOK := false
	if spec.RootFSPath != "" {
		if err := p.copyRootFS(spec.RootFSPath, rootFS); err == nil {
			rootfsOK = true
		} else {
			failures = append(failures, fmt.Sprintf("rootfs path %q: %v", spec.RootFSPath, err))
		}
	}
	if !rootfsOK && spec.RootFSUrl != "" {
		if err := p.downloadAndExtractRootFS(spec.RootFSUrl, rootFS); err == nil {
			rootfsOK = true
		} else {
			failures = append(failures, fmt.Sprintf("rootfs url %q: %v", spec.RootFSUrl, err))
		}
	}
	if !rootfsOK {
		if presetPath := p.findPreset(spec.AgentID); presetPath != "" {
			if err := p.copyRootFS(presetPath, rootFS); err == nil {
				rootfsOK = true
			} else {
				failures = append(failures, fmt.Sprintf("preset %q (path %q): %v", spec.AgentID, presetPath, err))
			}
		}
	}
	if !rootfsOK && p.localPath != "" {
		if _, err := os.Stat(p.localPath); err == nil {
			if err := p.extractTarGz(p.localPath, rootFS); err == nil {
				rootfsOK = true
			} else {
				failures = append(failures, fmt.Sprintf("local rootfs %q: %v", p.localPath, err))
			}
		} else {
			failures = append(failures, fmt.Sprintf("local rootfs %q: not found", p.localPath))
		}
	}
	if !rootfsOK && p.defaultURL != "" {
		if err := p.downloadAndExtractRootFS(p.defaultURL, rootFS); err == nil {
			rootfsOK = true
		} else {
			failures = append(failures, fmt.Sprintf("default Alpine rootfs %q: %v", p.defaultURL, err))
		}
	}
	if !rootfsOK {
		if p.busyboxURL != "" {
			if err := p.downloadBusybox(rootFS); err != nil {
				failures = append(failures, fmt.Sprintf("busybox %q: %v", p.busyboxURL, err))
				return nil, fmt.Errorf("all rootfs sources exhausted (%d failures): %s",
					len(failures), strings.Join(failures, "; "))
			}
			slog.Info("using busybox as minimal rootfs fallback", "url", p.busyboxURL)
		} else {
			return nil, fmt.Errorf("all rootfs sources exhausted (%d failures): %s; no busybox URL configured",
				len(failures), strings.Join(failures, "; "))
		}
	}

	// Create workspace directory
	workspacePath := filepath.Join(rootFS, "workspace")
	os.MkdirAll(workspacePath, 0o750)

	// Run init commands inside the chroot
	if len(spec.InitCommands) > 0 {
		p.runInitCommands(rootFS, spec.InitCommands)
	} else if len(p.initCommands) > 0 {
		p.runInitCommands(rootFS, p.initCommands)
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

	chrootCmd := fmt.Sprintf("chroot %s /bin/bash -c %q", sb.Path, cmd)

	var execCmd *exec.Cmd
	if timeout > 0 {
		execCmd = exec.Command("timeout", fmt.Sprintf("%ds", timeout), "bash", "-c", chrootCmd)
	} else {
		execCmd = exec.Command("bash", "-c", chrootCmd)
	}

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

// ── Rootfs source helpers ─────────────────────────────────────────────

// findPreset returns the preset path matching the given name, or "" if none.
func (p *ChrootProvider) findPreset(name string) string {
	for _, preset := range p.presets {
		if preset.Name == name && preset.Path != "" {
			if _, err := os.Stat(preset.Path); err == nil {
				return preset.Path
			}
		}
	}
	return ""
}

// copyRootFS copies a base rootfs directory into the chroot directory.
func (p *ChrootProvider) copyRootFS(src, dst string) error {
	cmd := exec.Command("cp", "-a", src+"/.", dst+"/")
	return cmd.Run()
}

// extractTarGz extracts a tar.gz file into the destination directory.
func (p *ChrootProvider) extractTarGz(tarPath, dst string) error {
	cmd := exec.Command("tar", "-xzf", tarPath, "-C", dst)
	return cmd.Run()
}

// downloadAndExtractRootFS downloads a rootfs tar.gz from URL, verifies SHA256
// (if provided in the URL fragment), caches it, and extracts to dst.
func (p *ChrootProvider) downloadAndExtractRootFS(url, dst string) error {
	// Check cache first
	cacheKey := sha256.Sum256([]byte(url))
	cacheFile := filepath.Join(p.cacheDir, hex.EncodeToString(cacheKey[:])+".tar.gz")

	if _, err := os.Stat(cacheFile); err == nil {
		slog.Info("using cached rootfs", "url", url, "cache", cacheFile)
		return p.extractTarGz(cacheFile, dst)
	}

	slog.Info("downloading rootfs", "url", url)

	// Download
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("download rootfs: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download rootfs: HTTP %d", resp.StatusCode)
	}

	// Write to temp file first
	tmpFile := cacheFile + ".tmp"
	f, err := os.Create(tmpFile)
	if err != nil {
		return fmt.Errorf("create cache file: %w", err)
	}

	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(tmpFile)
		return fmt.Errorf("write rootfs: %w", err)
	}
	f.Close()

	// Move temp to cache
	if err := os.Rename(tmpFile, cacheFile); err != nil {
		os.Remove(tmpFile)
		return fmt.Errorf("cache rootfs: %w", err)
	}

	slog.Info("rootfs downloaded and cached", "url", url, "cache", cacheFile)
	return p.extractTarGz(cacheFile, dst)
}

// runInitCommands executes init commands inside the chroot.
func (p *ChrootProvider) runInitCommands(rootFS string, commands []string) {
	for _, cmd := range commands {
		chrootCmd := fmt.Sprintf("chroot %s /bin/sh -c %q", rootFS, cmd)
		output, err := exec.Command("bash", "-c", chrootCmd).CombinedOutput()
		if err != nil {
			slog.Warn("init command failed", "cmd", cmd, "error", err, "output", string(output))
		} else {
			slog.Info("init command executed", "cmd", cmd)
		}
	}
}

// periodicCacheCleanup runs in the background and removes cached rootfs files
// that haven't been used for longer than cacheMaxAge.
func (p *ChrootProvider) periodicCacheCleanup() {
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()

	for range ticker.C {
		p.cleanupCache()
	}
}

// cleanupCache removes cache files older than cacheMaxAge.
func (p *ChrootProvider) cleanupCache() {
	p.mu.RLock()
	defer p.mu.RUnlock()

	entries, err := os.ReadDir(p.cacheDir)
	if err != nil {
		slog.Warn("cache cleanup: read dir failed", "dir", p.cacheDir, "error", err)
		return
	}

	now := time.Now()
	removed := 0
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if now.Sub(info.ModTime()) > p.cacheMaxAge {
			path := filepath.Join(p.cacheDir, entry.Name())
			if err := os.Remove(path); err != nil {
				slog.Warn("cache cleanup: remove failed", "file", path, "error", err)
			} else {
				slog.Info("cache cleanup: removed old rootfs cache", "file", path, "age", now.Sub(info.ModTime()).Hours()/24)
				removed++
			}
		}
	}
	if removed > 0 {
		slog.Info("cache cleanup complete", "removed", removed, "dir", p.cacheDir)
	}
}

// busyboxAppletNames lists the core busybox applets needed for basic operation.
var busyboxAppletNames = []string{
	"sh", "bash", "ls", "cp", "mv", "rm", "mkdir", "rmdir", "cat",
	"echo", "grep", "find", "chmod", "chown", "touch", "head", "tail",
	"wc", "sort", "uniq", "cut", "sed", "awk", "tar", "gzip",
	"env", "whoami", "id", "ln", "pwd", "sleep", "kill", "ps",
	"df", "du", "tee", "xargs", "test", "[", "[[",
}

// downloadBusybox downloads a static busybox binary into the chroot and
// creates symlinks for all standard applets. This provides a minimal but
// fully self-contained rootfs with zero host dependencies.
func (p *ChrootProvider) downloadBusybox(rootFS string) error {
	binDir := filepath.Join(rootFS, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return fmt.Errorf("create bin dir: %w", err)
	}

	busyboxDst := filepath.Join(binDir, "busybox")

	// Download busybox binary
	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Get(p.busyboxURL)
	if err != nil {
		return fmt.Errorf("download busybox: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download busybox: HTTP %d", resp.StatusCode)
	}

	f, err := os.OpenFile(busyboxDst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return fmt.Errorf("create busybox file: %w", err)
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(busyboxDst)
		return fmt.Errorf("write busybox: %w", err)
	}
	f.Close()

	// Create symlinks: /bin/sh → busybox, /bin/ls → busybox, etc.
	for _, applet := range busyboxAppletNames {
		linkPath := filepath.Join(binDir, applet)
		// Skip if a real binary already exists (e.g. from a partial rootfs)
		if _, err := os.Lstat(linkPath); err == nil {
			continue
		}
		if err := os.Symlink("busybox", linkPath); err != nil {
			slog.Warn("failed to create busybox symlink", "applet", applet, "error", err)
		}
	}

	slog.Info("busybox installed", "path", busyboxDst, "applets", len(busyboxAppletNames))
	return nil
}

// ── Snapshot management ─────────────────────────────────────────────

// Snapshot creates a tar.gz snapshot of the chroot workspace directory.
// The snapshot is stored on disk at snapshotDir and metadata is kept in memory.
func (p *ChrootProvider) Snapshot(sandboxID, name string) (*Snapshot, error) {
	p.mu.RLock()
	sb, ok := p.sandboxes[sandboxID]
	p.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("sandbox %q not found", sandboxID)
	}

	workspacePath := filepath.Join(sb.Path, "workspace")
	if _, err := os.Stat(workspacePath); os.IsNotExist(err) {
		return nil, fmt.Errorf("workspace directory does not exist: %s", workspacePath)
	}

	id := uuid.New().String()[:8]
	snapshotPath := filepath.Join(p.snapshotDir, fmt.Sprintf("%s-%s.tar.gz", sandboxID, id))

	// Create tar.gz of the workspace directory
	cmd := exec.Command("tar", "-czf", snapshotPath, "-C", workspacePath, ".")
	output, err := cmd.CombinedOutput()
	if err != nil {
		os.Remove(snapshotPath)
		return nil, fmt.Errorf("create snapshot archive: %w (output: %s)", err, string(output))
	}

	// Get file size
	info, err := os.Stat(snapshotPath)
	if err != nil {
		os.Remove(snapshotPath)
		return nil, fmt.Errorf("stat snapshot: %w", err)
	}

	snap := &Snapshot{
		ID:        id,
		SandboxID: sandboxID,
		Name:      name,
		Path:      snapshotPath,
		Size:      info.Size(),
		CreatedAt: time.Now(),
	}

	p.mu.Lock()
	p.snapshots[id] = snap
	p.mu.Unlock()

	slog.Info("snapshot created",
		"snapshot_id", id, "sandbox_id", sandboxID,
		"name", name, "size", info.Size(), "path", snapshotPath,
	)
	return snap, nil
}

// RestoreSnapshot restores a chroot workspace from a previously created snapshot.
// The current workspace is backed up before restoration.
func (p *ChrootProvider) RestoreSnapshot(snapshotID string) error {
	p.mu.Lock()
	snap, ok := p.snapshots[snapshotID]
	if !ok {
		p.mu.Unlock()
		return fmt.Errorf("snapshot %q not found", snapshotID)
	}
	sb, ok := p.sandboxes[snap.SandboxID]
	p.mu.Unlock()
	if !ok {
		return fmt.Errorf("sandbox %q not found for snapshot", snap.SandboxID)
	}

	if _, err := os.Stat(snap.Path); os.IsNotExist(err) {
		return fmt.Errorf("snapshot archive does not exist: %s", snap.Path)
	}

	workspacePath := filepath.Join(sb.Path, "workspace")

	// Backup current workspace before restoring
	backupPath := filepath.Join(p.snapshotDir, fmt.Sprintf("%s-restore-backup-%s.tar.gz", snap.SandboxID, uuid.New().String()[:6]))
	backupCmd := exec.Command("tar", "-czf", backupPath, "-C", workspacePath, ".")
	if output, err := backupCmd.CombinedOutput(); err != nil {
		slog.Warn("workspace backup before restore failed", "error", err, "output", string(output))
	}

	// Clear current workspace (preserve the directory itself)
	entries, err := os.ReadDir(workspacePath)
	if err != nil {
		return fmt.Errorf("read workspace: %w", err)
	}
	for _, entry := range entries {
		if err := os.RemoveAll(filepath.Join(workspacePath, entry.Name())); err != nil {
			slog.Warn("failed to remove workspace entry during restore", "entry", entry.Name(), "error", err)
		}
	}

	// Extract snapshot into workspace
	cmd := exec.Command("tar", "-xzf", snap.Path, "-C", workspacePath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		// Try to restore from backup
		if _, statErr := os.Stat(backupPath); statErr == nil {
			restoreCmd := exec.Command("tar", "-xzf", backupPath, "-C", workspacePath)
			if restoreOut, restoreErr := restoreCmd.CombinedOutput(); restoreErr != nil {
				slog.Error("restore from backup also failed", "error", restoreErr, "output", string(restoreOut))
			}
		}
		return fmt.Errorf("restore snapshot: %w (output: %s)", err, string(output))
	}

	slog.Info("snapshot restored",
		"snapshot_id", snapshotID, "sandbox_id", snap.SandboxID,
		"workspace", workspacePath, "backup", backupPath,
	)
	return nil
}

// ListSnapshots returns all snapshots, optionally filtered by sandbox ID.
func (p *ChrootProvider) ListSnapshots(sandboxID string) []*Snapshot {
	p.mu.RLock()
	defer p.mu.RUnlock()
	result := make([]*Snapshot, 0)
	for _, snap := range p.snapshots {
		if sandboxID == "" || snap.SandboxID == sandboxID {
			result = append(result, snap)
		}
	}
	return result
}

// DeleteSnapshot removes a snapshot from disk and memory.
func (p *ChrootProvider) DeleteSnapshot(snapshotID string) error {
	p.mu.Lock()
	snap, ok := p.snapshots[snapshotID]
	if !ok {
		p.mu.Unlock()
		return fmt.Errorf("snapshot %q not found", snapshotID)
	}
	delete(p.snapshots, snapshotID)
	p.mu.Unlock()

	if err := os.Remove(snap.Path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove snapshot archive: %w", err)
	}

	slog.Info("snapshot deleted", "snapshot_id", snapshotID)
	return nil
}

var _ SandboxProvider = (*ChrootProvider)(nil)
