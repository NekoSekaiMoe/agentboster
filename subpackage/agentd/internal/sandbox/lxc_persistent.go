//go:build linux
// +build linux

package sandbox

import (
	"bufio"
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/clawless/agentd/internal/security/os_enforce"
	"github.com/google/uuid"
)

// LXCPersistentProvider implements SandboxProvider using LXC containers.
// Containers persist across sessions and support full init systems.
type LXCPersistentProvider struct {
	mu             sync.RWMutex
	rootfsBase     string
	defaultDistro  string
	defaultRelease string
	sandboxes      map[string]*Sandbox
	initialized    map[string]bool
}

// NewLXCPersistentProvider creates a new LXC persistent sandbox provider.
func NewLXCPersistentProvider(rootfsBase, defaultDistro, defaultRelease string) *LXCPersistentProvider {
	if rootfsBase == "" {
		rootfsBase = "/var/lib/agentd/lxc"
	}
	if defaultDistro == "" {
		defaultDistro = "alpine"
	}
	if defaultRelease == "" {
		defaultRelease = "3.21"
	}
	return &LXCPersistentProvider{
		rootfsBase:     rootfsBase,
		defaultDistro:  defaultDistro,
		defaultRelease: defaultRelease,
		sandboxes:      make(map[string]*Sandbox),
		initialized:    make(map[string]bool),
	}
}

// Create creates or resumes an LXC persistent container.
func (p *LXCPersistentProvider) Create(spec SandboxSpec) (*Sandbox, error) {
	id := uuid.New().String()[:8]
	containerName := fmt.Sprintf("agentd-lxc-%s", id)

	distro := spec.Distro
	if distro == "" {
		distro = p.defaultDistro
	}
	release := spec.Release
	if release == "" {
		release = p.defaultRelease
	}

	containerPath := filepath.Join(p.rootfsBase, containerName)
	rootfsPath := p.findRootfs(containerPath)

	cpu := spec.CPULimit
	if cpu <= 0 {
		cpu = 1.0
	}
	memBytes := spec.MemoryLimit
	if memBytes <= 0 {
		memBytes = 512 * 1024 * 1024
	}
	memMB := memBytes / (1024 * 1024)

	isNew := rootfsPath == ""

	if isNew {
		if err := os.MkdirAll(p.rootfsBase, 0o755); err != nil {
			return nil, fmt.Errorf("create lxc base dir: %w", err)
		}

		createCmd := exec.Command("lxc-create",
			"-t", "download",
			"-n", containerName,
			"-P", p.rootfsBase,
			"--", "--dist", distro, "--release", release,
		)
		output, err := createCmd.CombinedOutput()
		if err != nil {
			return nil, fmt.Errorf("lxc-create failed: %w (output: %s)", err, string(output))
		}

		rootfsPath = p.findRootfs(containerPath)
		if rootfsPath == "" {
			return nil, fmt.Errorf("lxc container created but rootfs not found at %s", containerPath)
		}

		p.writeCgroupLimits(containerPath, cpu, memMB)

		// Apply OS-level security enforcement
		if spec.SecurityPolicy != nil {
			writeSecurityConfig(containerPath, spec.SecurityPolicy)
		}

		if err := InitWorkspaceLayout(rootfsPath); err != nil {
			slog.Warn("lxc workspace layout init failed", "error", err)
		}
	}

	startCmd := exec.Command("lxc-start", "-n", containerName, "-P", p.rootfsBase, "-d")
	if output, err := startCmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("lxc-start failed: %w (output: %s)", err, string(output))
	}

	time.Sleep(2 * time.Second)

	if isNew && len(spec.InitCommands) > 0 {
		for _, initCmd := range spec.InitCommands {
			cmd := exec.Command("lxc-attach", "-n", containerName, "-P", p.rootfsBase, "--", "sh", "-c", initCmd)
			if output, err := cmd.CombinedOutput(); err != nil {
				slog.Warn("lxc init command failed", "cmd", initCmd, "error", err, "output", string(output))
			}
		}
		p.mu.Lock()
		p.initialized[id] = true
		p.mu.Unlock()
	}

	sb := &Sandbox{
		ID:         id,
		Type:       "lxc",
		Path:       containerName,
		Status:     "ready",
		Persistent: true,
		CreatedAt:  time.Now(),
	}

	p.mu.Lock()
	p.sandboxes[id] = sb
	p.mu.Unlock()

	if isNew {
		slog.Info("lxc sandbox created", "id", id, "container", containerName, "distro", distro, "release", release)
	} else {
		slog.Info("lxc sandbox resumed", "id", id, "container", containerName)
	}

	return sb, nil
}

// Exec runs a command inside the LXC container.
func (p *LXCPersistentProvider) Exec(sandboxID, cmd string, env map[string]string, timeout int) (*ExecResult, error) {
	p.mu.RLock()
	sb, ok := p.sandboxes[sandboxID]
	p.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("sandbox %q not found", sandboxID)
	}

	lxcArgs := []string{"-n", sb.Path, "-P", p.rootfsBase}
	for k, v := range env {
		lxcArgs = append(lxcArgs, "-s", k+"="+v)
	}
	lxcArgs = append(lxcArgs, "--", "sh", "-c", cmd)

	var execCmd *exec.Cmd
	if timeout > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Second)
		defer cancel()
		execCmd = exec.CommandContext(ctx, "lxc-attach", lxcArgs...)
	} else {
		execCmd = exec.Command("lxc-attach", lxcArgs...)
	}

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
	}

	return result, nil
}

// Destroy stops and optionally destroys the LXC container.
//
// Behavior depends on the Sandbox.Persistent flag set at Create time:
//   - Persistent=true  → lxc-stop only (rootfs preserved)
//   - Persistent=false → lxc-destroy -f (rootfs removed)
//
// LXC persistent sandboxes are created with Persistent=true (see Create),
// so the default Destroy path leaves rootfs intact for the next session.
// Use DestroyForce to unconditionally remove the rootfs regardless of
// the Persistent flag — this is the path taken by session deletion and
// the user-facing sandbox_destroy tool.
func (p *LXCPersistentProvider) Destroy(sandboxID string) error {
	return p.destroyInternal(sandboxID, false)
}

// DestroyForce stops AND lxc-destroy's the container unconditionally.
// Used when a session is permanently deleted or the user explicitly
// requests sandbox teardown — in both cases the rootfs should not
// survive, otherwise it leaks.
func (p *LXCPersistentProvider) DestroyForce(sandboxID string) error {
	return p.destroyInternal(sandboxID, true)
}

func (p *LXCPersistentProvider) destroyInternal(sandboxID string, force bool) error {
	p.mu.Lock()
	sb, ok := p.sandboxes[sandboxID]
	if !ok {
		p.mu.Unlock()
		return fmt.Errorf("sandbox %q not found", sandboxID)
	}
	delete(p.sandboxes, sandboxID)
	delete(p.initialized, sandboxID)
	p.mu.Unlock()

	stopCmd := exec.Command("lxc-stop", "-n", sb.Path, "-P", p.rootfsBase)
	if output, err := stopCmd.CombinedOutput(); err != nil {
		slog.Warn("lxc-stop failed", "container", sb.Path, "error", err, "output", string(output))
	}

	if sb.Persistent && !force {
		slog.Info("lxc sandbox stopped (persistent, rootfs preserved)", "id", sandboxID)
		return nil
	}

	destroyCmd := exec.Command("lxc-destroy", "-n", sb.Path, "-P", p.rootfsBase, "-f")
	if output, err := destroyCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("lxc-destroy failed: %w (output: %s)", err, string(output))
	}

	containerPath := filepath.Join(p.rootfsBase, sb.Path)
	os.RemoveAll(containerPath)

	slog.Info("lxc sandbox destroyed", "id", sandboxID, "force", force)
	return nil
}

// Status returns LXC container status.
func (p *LXCPersistentProvider) Status(sandboxID string) (*Sandbox, error) {
	p.mu.RLock()
	sb, ok := p.sandboxes[sandboxID]
	p.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("sandbox %q not found", sandboxID)
	}

	cmd := exec.Command("lxc-info", "-n", sb.Path, "-P", p.rootfsBase, "-s")
	output, err := cmd.CombinedOutput()
	if err != nil {
		sb.Status = "destroyed"
		return sb, nil
	}

	statusLine := strings.TrimSpace(string(output))
	statusLine = strings.TrimPrefix(statusLine, "State:")
	statusLine = strings.TrimSpace(statusLine)

	switch strings.ToUpper(statusLine) {
	case "RUNNING":
		sb.Status = "ready"
	case "STOPPED":
		sb.Status = "stopped"
	default:
		sb.Status = strings.ToLower(statusLine)
	}

	return sb, nil
}

// RootfsPath returns the host path to the container's rootfs.
func (p *LXCPersistentProvider) RootfsPath(sandboxID string) string {
	p.mu.RLock()
	sb, ok := p.sandboxes[sandboxID]
	p.mu.RUnlock()
	if !ok {
		return ""
	}
	containerPath := filepath.Join(p.rootfsBase, sb.Path)
	return p.findRootfs(containerPath)
}

// findRootfs locates the rootfs directory inside an LXC container path.
func (p *LXCPersistentProvider) findRootfs(containerPath string) string {
	configFile := filepath.Join(containerPath, "config")
	if f, err := os.Open(configFile); err == nil {
		defer f.Close()
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if strings.HasPrefix(line, "lxc.rootfs.path") || strings.HasPrefix(line, "lxc.rootfs ") {
				parts := strings.SplitN(line, "=", 2)
				if len(parts) == 2 {
					path := strings.TrimSpace(parts[1])
					if strings.HasPrefix(path, "dir:") {
						path = strings.TrimPrefix(path, "dir:")
					}
					if info, err := os.Stat(path); err == nil && info.IsDir() {
						return path
					}
				}
			}
		}
	}

	candidates := []string{
		filepath.Join(containerPath, "rootfs"),
		filepath.Join(containerPath, "rootfs", "rootfs"),
	}
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && info.IsDir() {
			return c
		}
	}
	return ""
}

// writeCgroupLimits writes CPU and memory limits to the LXC container config.
func (p *LXCPersistentProvider) writeCgroupLimits(containerPath string, cpu float64, memMB int64) {
	configFile := filepath.Join(containerPath, "config")
	f, err := os.OpenFile(configFile, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o644)
	if err != nil {
		slog.Warn("failed to open lxc config for cgroup limits", "error", err)
		return
	}
	defer f.Close()

	cpuQuota := int64(cpu * 100000)
	fmt.Fprintf(f, "\n# Agent resource limits\n")
	fmt.Fprintf(f, "lxc.cgroup2.cpu.max = %d 100000\n", cpuQuota)
	fmt.Fprintf(f, "lxc.cgroup2.memory.max = %d\n", memMB*1024*1024)
	fmt.Fprintf(f, "lxc.cgroup.cpu.cfs_quota_us = %d\n", cpuQuota)
	fmt.Fprintf(f, "lxc.cgroup.cpu.cfs_period_us = 100000\n")
	fmt.Fprintf(f, "lxc.cgroup.memory.limit_in_bytes = %d\n", memMB*1024*1024)
}

// writeSecurityConfig writes OS-level security enforcement directives to the LXC container config.
// This includes capability drops, seccomp profiles, mount restrictions, and network isolation.
func writeSecurityConfig(containerPath string, policy *os_enforce.OSPolicy) {
	configFile := filepath.Join(containerPath, "config")
	f, err := os.OpenFile(configFile, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o644)
	if err != nil {
		slog.Warn("failed to open lxc config for security config", "error", err)
		return
	}
	defer f.Close()

	fmt.Fprintf(f, "\n# Agent security enforcement (os_enforce)\n")

	// === Capability drops ===
	if len(policy.CapDrop) > 0 {
		lxcCaps := os_enforce.LXCFormatCaps(policy.CapDrop)
		fmt.Fprintf(f, "lxc.cap.drop = %s\n", strings.Join(lxcCaps, " "))
	}

	// === Seccomp profile ===
	if policy.Seccomp != nil {
		seccompPath := filepath.Join(containerPath, "seccomp.conf")
		seccompContent := policy.Seccomp.ToLXCFormat()
		if err := os.WriteFile(seccompPath, []byte(seccompContent), 0o644); err != nil {
			slog.Warn("failed to write lxc seccomp profile", "error", err)
		} else {
			fmt.Fprintf(f, "lxc.seccomp.profile = %s\n", seccompPath)
		}
	}

	// === Mount auto restrictions (read-only proc/sys) ===
	fmt.Fprintf(f, "lxc.mount.auto = proc:mixed sys:mixed cgroup:mixed\n")

	// === Masked paths (bind /dev/null over sensitive files) ===
	for _, mp := range policy.MaskedPaths {
		cleanPath := strings.TrimPrefix(mp, "/")
		fmt.Fprintf(f, "lxc.mount.entry = /dev/null %s none bind,ro,create=file 0 0\n", cleanPath)
	}

	// === Read-only paths ===
	for _, rp := range policy.ReadonlyPaths {
		cleanPath := strings.TrimPrefix(rp, "/")
		fmt.Fprintf(f, "lxc.mount.entry = %s %s none bind,ro 0 0\n", rp, cleanPath)
	}

	// === Network isolation ===
	if policy.NetworkNone {
		fmt.Fprintf(f, "lxc.net.0.type = none\n")
	}

	slog.Info("LXC security config written",
		"container", containerPath,
		"cap_drop", len(policy.CapDrop),
		"masked_paths", len(policy.MaskedPaths),
		"network_none", policy.NetworkNone,
	)
}

var _ SandboxProvider = (*LXCPersistentProvider)(nil)
