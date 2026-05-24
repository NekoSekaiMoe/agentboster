//go:build linux
// +build linux

package sandbox

import (
	"bufio"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// TmpfsProvider implements SandboxProvider using tmpfs mounts.
type TmpfsProvider struct {
	mu        sync.RWMutex
	workDir   string
	sandboxes map[string]*Sandbox
}

// NewTmpfsProvider creates a new tmpfs sandbox provider.
func NewTmpfsProvider(workDir string) *TmpfsProvider {
	return &TmpfsProvider{
		workDir:   workDir,
		sandboxes: make(map[string]*Sandbox),
	}
}

// Create creates a tmpfs-backed sandbox.
func (p *TmpfsProvider) Create(spec SandboxSpec) (*Sandbox, error) {
	id := uuid.New().String()[:8]
	baseDir := filepath.Join(p.workDir, "tmpfs", id)

	if err := os.MkdirAll(baseDir, 0o750); err != nil {
		return nil, fmt.Errorf("create sandbox dir: %w", err)
	}

	// Determine final tmpfs size: AI eval hint → memory probe → final size
	evalHint := spec.TmpfsEvalHint
	if evalHint <= 0 {
		evalHint = 50 * 1024 * 1024 // default 50MB
	}
	finalSize := p.probeAndResolveSize(evalHint)

	// Mount tmpfs with resolved size
	sizeStr := fmt.Sprintf("%d", finalSize)
	mountCmd := exec.Command("mount", "-t", "tmpfs", "-o", "size="+sizeStr, "tmpfs", baseDir)
	if err := mountCmd.Run(); err != nil {
		slog.Warn("tmpfs mount failed, using regular directory", "error", err, "dir", baseDir)
	}

	for _, subdir := range []string{"workspace", "tmp", "home"} {
		os.MkdirAll(filepath.Join(baseDir, subdir), 0o750)
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

	slog.Info("tmpfs sandbox created", "id", id, "path", baseDir, "size", sizeStr,
		"eval_hint", evalHint, "final_bytes", finalSize)
	return sb, nil
}

// Exec runs a command inside the tmpfs sandbox.
func (p *TmpfsProvider) Exec(sandboxID, cmd string, env map[string]string, timeout int) (*ExecResult, error) {
	p.mu.RLock()
	sb, ok := p.sandboxes[sandboxID]
	p.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("sandbox %q not found", sandboxID)
	}

	// Pre-execution: check remaining space, try expand if < 10%
	p.ensureSpace(sb, 10)

	workspaceDir := filepath.Join(sb.Path, "workspace")

	var execCmd *exec.Cmd
	if timeout > 0 {
		execCmd = exec.Command("timeout", fmt.Sprintf("%ds", timeout), "bash", "-c", cmd)
	} else {
		execCmd = exec.Command("bash", "-c", cmd)
	}
	execCmd.Dir = workspaceDir
	execCmd.Env = os.Environ()
	for k, v := range env {
		execCmd.Env = append(execCmd.Env, k+"="+v)
	}
	execCmd.Env = append(execCmd.Env,
		"HOME="+filepath.Join(sb.Path, "home"),
		"TMPDIR="+filepath.Join(sb.Path, "tmp"),
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

		// If "No space left on device", try expand immediately
		if strings.Contains(string(output), "No space left on device") ||
			strings.Contains(string(output), "ENOSPC") {
			slog.Warn("tmpfs out of space, attempting emergency expand", "sandbox", sandboxID)
			if expandErr := p.tryExpand(sb); expandErr != nil {
				slog.Error("tmpfs emergency expand failed", "sandbox", sandboxID, "error", expandErr)
			} else {
				slog.Info("tmpfs emergency expand succeeded", "sandbox", sandboxID)
			}
		}
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

	umountCmd := exec.Command("umount", sb.Path)
	if err := umountCmd.Run(); err != nil {
		slog.Warn("tmpfs unmount failed, falling back to rm", "error", err, "path", sb.Path)
	}

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
	for i, m := range matches {
		rel, err := filepath.Rel(sbPath, m)
		if err != nil {
			rel = m
		}
		matches[i] = rel
	}
	return matches, nil
}

// ── Memory probe & size resolution ────────────────────────────────────

// probeAndResolveSize takes an AI-evaluated hint (bytes) and returns the
// actual size to allocate after probing available memory.
func (p *TmpfsProvider) probeAndResolveSize(evalHint int64) int64 {
	zramAvail := p.probeZram()
	memAvail := p.probeMemAvailable()
	swapAvail := p.probeSwapAvailable()

	slog.Info("memory probe", "eval_hint", evalHint, "zram_avail", zramAvail, "mem_avail", memAvail, "swap_avail", swapAvail)

	// Priority: zram → physical memory → swap
	for _, avail := range []int64{zramAvail, memAvail, swapAvail} {
		usable := avail * 60 / 100 // use up to 60% of available
		if usable >= evalHint {
			return evalHint
		}
	}

	// All tiers insufficient: take 80% of best available
	best := max3(zramAvail, memAvail, swapAvail)
	if best <= 0 {
		return 10 * 1024 * 1024 // absolute minimum 10MB
	}
	result := best * 80 / 100
	if result < evalHint/2 {
		slog.Warn("tmpfs allocated less than 50% of eval hint",
			"eval_hint", evalHint, "allocated", result,
			"zram_avail", zramAvail, "mem_avail", memAvail, "swap_avail", swapAvail)
	}
	return result
}

// probeZram returns available zram space in bytes, or 0 if unavailable.
func (p *TmpfsProvider) probeZram() int64 {
	// Check zram disksize
	data, err := os.ReadFile("/sys/block/zram0/disksize")
	if err != nil {
		return 0
	}
	diskSize, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	if err != nil || diskSize <= 0 {
		return 0
	}
	// Check how much is used
	data, err = os.ReadFile("/sys/block/zram0/mem_used_total")
	if err != nil {
		// Fallback: assume 50% available
		return diskSize / 2
	}
	used, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	if err != nil {
		return diskSize / 2
	}
	avail := diskSize - used
	if avail < 0 {
		return 0
	}
	return avail
}

// probeMemAvailable returns MemAvailable from /proc/meminfo in bytes.
func (p *TmpfsProvider) probeMemAvailable() int64 {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "MemAvailable:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				kb, err := strconv.ParseInt(fields[1], 10, 64)
				if err == nil {
					return kb * 1024
				}
			}
		}
	}
	return 0
}

// probeSwapAvailable returns available swap space in bytes.
func (p *TmpfsProvider) probeSwapAvailable() int64 {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()

	var swapTotal, swapFree int64
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "SwapTotal:") {
			if fields := strings.Fields(line); len(fields) >= 2 {
				swapTotal, _ = strconv.ParseInt(fields[1], 10, 64)
			}
		} else if strings.HasPrefix(line, "SwapFree:") {
			if fields := strings.Fields(line); len(fields) >= 2 {
				swapFree, _ = strconv.ParseInt(fields[1], 10, 64)
			}
		}
	}
	if swapTotal <= 0 || swapFree <= 0 {
		return 0
	}
	return swapFree * 1024
}

// ── Space check & expand ──────────────────────────────────────────────

// ensureSpace checks remaining space on the tmpfs and expands if usage > threshold%.
func (p *TmpfsProvider) ensureSpace(sb *Sandbox, thresholdPercent int) {
	used, total, err := p.getTmpfsUsage(sb.Path)
	if err != nil {
		return
	}
	if total <= 0 {
		return
	}
	usagePercent := used * 100 / total
	if usagePercent >= int64(100-thresholdPercent) {
		slog.Warn("tmpfs space low, attempting expand", "sandbox", sb.ID,
			"used", used, "total", total, "usage_pct", usagePercent)
		p.tryExpand(sb)
	}
}

// getTmpfsUsage returns (used_bytes, total_bytes) for a tmpfs mount.
func (p *TmpfsProvider) getTmpfsUsage(mountPoint string) (int64, int64, error) {
	output, err := exec.Command("df", "--output=used,used", mountPoint).CombinedOutput()
	if err != nil {
		return 0, 0, err
	}
	// Use stat for more reliable output
	output, err = exec.Command("stat", "-f", "--format=%a,%b,%s", mountPoint).CombinedOutput()
	if err != nil {
		return 0, 0, err
	}
	parts := strings.Split(strings.TrimSpace(string(output)), ",")
	if len(parts) != 3 {
		return 0, 0, fmt.Errorf("unexpected stat output: %s", string(output))
	}
	freeBlocks, _ := strconv.ParseInt(parts[0], 10, 64)
	totalBlocks, _ := strconv.ParseInt(parts[1], 10, 64)
	blockSize, _ := strconv.ParseInt(parts[2], 10, 64)
	total := totalBlocks * blockSize
	avail := freeBlocks * blockSize
	used := total - avail
	return used, total, nil
}

// tryExpand attempts to expand the tmpfs mount.
// New size = min(eval_hint * 3, best_available * 60%)
func (p *TmpfsProvider) tryExpand(sb *Sandbox) error {
	zramAvail := p.probeZram()
	memAvail := p.probeMemAvailable()
	swapAvail := p.probeSwapAvailable()
	bestAvail := max3(zramAvail, memAvail, swapAvail)

	// We don't store the original eval_hint on the sandbox, so use current total as baseline
	_, currentTotal, err := p.getTmpfsUsage(sb.Path)
	if err != nil {
		return fmt.Errorf("get current usage: %w", err)
	}

	// Expand target: up to 3x current or 60% of best available, whichever is smaller
	targetByCurrent := currentTotal * 3
	targetByAvail := bestAvail * 60 / 100
	newSize := targetByCurrent
	if targetByAvail < newSize {
		newSize = targetByAvail
	}
	if newSize <= currentTotal {
		return fmt.Errorf("no expandable space: current=%d best_avail=%d", currentTotal, bestAvail)
	}

	sizeStr := fmt.Sprintf("%d", newSize)
	cmd := exec.Command("mount", "-o", "remount,size="+sizeStr, sb.Path)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("remount failed: %w (output: %s)", err, string(output))
	}

	slog.Info("tmpfs expanded", "sandbox", sb.ID, "old_size", currentTotal, "new_size", newSize)
	return nil
}

func max3(a, b, c int64) int64 {
	m := a
	if b > m {
		m = b
	}
	if c > m {
		m = c
	}
	return m
}

var _ SandboxProvider = (*TmpfsProvider)(nil)
