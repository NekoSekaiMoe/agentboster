//go:build linux
// +build linux

package sandbox

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/config"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/security/l0_rules"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/security/os_enforce"
)

const (
	PermissionProfileDefault        = "default"
	PermissionProfileStrict         = "strict"
	PermissionProfileNetwork        = "network"
	PermissionProfilePackageInstall = "package-install"
	PermissionProfileBrowser        = "browser"
	PermissionProfilePersistent     = "persistent"
)

// SandboxProvider is the interface for sandbox implementations.
type SandboxProvider interface {
	Create(spec SandboxSpec) (*Sandbox, error)
	Exec(sandboxID string, cmd string, env map[string]string, timeout int) (*ExecResult, error)
	Destroy(sandboxID string) error
	Status(sandboxID string) (*Sandbox, error)
	Restart(sandboxID string) error
}

// SandboxSpec defines how to create a sandbox.
type SandboxSpec struct {
	Type              string
	AgentID           string
	Persistent        bool     // true = LXC persistent container
	Distro            string   // LXC distro (default: alpine)
	Release           string   // LXC release (default: 3.21)
	InitCommands      []string // LXC init commands after first boot
	CPULimit          float64  // CPU cores limit (Docker: 0.25, LXC: 1.0)
	MemoryLimit       int64    // Memory limit in bytes (Docker: 256MB, LXC: 512MB)
	Image             string   // Docker image
	Mounts            []Mount
	Environment       map[string]string
	WorkDir           string
	SecurityLevel     string               // "light" (default) or "strict" (Docker only)
	PermissionProfile string               // fixed permission profile requested by the model
	UserSpecified     bool                 // true if user explicitly specified sandbox type
	SecurityPolicy    *os_enforce.OSPolicy // OS-level enforcement (nil = skip)

	// P1.1: per-spec resource knobs (populated from clawless.AgentConfig
	// when set, otherwise provider defaults apply).
	PidsLimit   int           // Docker --pids-limit; 0 = provider default (e.g. 128 for strict)
	DiskLimit   string        // Quota (e.g. "1g"); empty = no quota
	BlkioWeight uint16        // 10-1000; 0 = provider default
	Timeout     time.Duration // Hard wall-clock cap; 0 = no cap (rely on caller's ctx)

	// P2.2: outbound egress allowlist (glob). Empty = unrestricted when
	// sandbox network is on. Applied by the provider after sandbox creation
	// via iptables in the sandbox's network namespace.
	EgressAllowlist []string
}

// Mount defines a bind mount.
type Mount struct {
	Source string
	Target string
	RO     bool
}

// Sandbox represents a running sandbox.
type Sandbox struct {
	ID         string
	Type       string
	Path       string
	Status     string
	Persistent bool
	CreatedAt  time.Time
}

// ExecResult is the result of a sandbox command execution.
type ExecResult struct {
	Stdout   string
	Stderr   string
	ExitCode int
	Duration time.Duration
}

// Manager manages sandbox providers and lifecycle.
type Manager struct {
	mu        sync.RWMutex
	providers map[string]SandboxProvider
	sandboxes map[string]*Sandbox
	config    *config.Config
	policy    *os_enforce.OSPolicy
	store     *SandboxStore
}

// NewManager creates a new sandbox manager with all built-in providers.
func NewManager(cfg *config.Config, l0Engine *l0_rules.Engine) *Manager {
	m := &Manager{
		providers: make(map[string]SandboxProvider),
		sandboxes: make(map[string]*Sandbox),
		config:    cfg,
	}

	// Sandbox store for crash-recovery (persists sandbox IDs to disk so
	// non-self-cleaning containers — docker-strict, LXC — can be reaped
	// after a daemon restart). Failures here are non-fatal: a nil store
	// becomes a no-op, the manager just loses recovery capability.
	storeDir := ""
	if cfg.Cache.Path != "" {
		storeDir = filepath.Join(cfg.Cache.Path, "sandboxes")
	}
	store, err := NewSandboxStore(storeDir)
	if err != nil {
		slog.Warn("sandbox store init failed; crash recovery disabled", "error", err)
	} else {
		m.store = store
	}

	// Generate OS enforcement policy from L0 rules
	if cfg.Sandbox.OSEnforce && l0Engine != nil {
		m.policy = os_enforce.FromL0Rules(l0Engine.Rules())
		m.policy.NetworkNone = cfg.Sandbox.NetworkIsolate
		slog.Info("OS enforcement enabled",
			"cap_drop", len(m.policy.CapDrop),
			"masked_paths", len(m.policy.MaskedPaths),
			"network_none", m.policy.NetworkNone,
		)
	}

	// Register built-in providers:
	// "docker" — light tasks (alpine:edge, --rm, low resource)
	dockerLight := NewDockerLightProvider(
		cfg.Sandbox.DockerSocket,
		cfg.Sandbox.DockerImage,
		cfg.Sandbox.DockerDefaultCPU,
		cfg.Sandbox.DockerDefaultMem,
	)
	m.providers["docker"] = dockerLight
	registerGlobal("docker", dockerLight)

	// "docker-strict" — high-risk/untrusted code (no network, read-only, cap-drop ALL)
	dockerStrict := NewDockerProvider(
		cfg.Sandbox.DockerSocket,
		cfg.Sandbox.AllowedImages,
		cfg.Sandbox.DockerStrictCPU,
		cfg.Sandbox.DockerStrictMem,
	)
	m.providers["docker-strict"] = dockerStrict
	registerGlobal("docker-strict", dockerStrict)

	// "lxc" — persistent containers
	lxc := NewLXCPersistentProvider(
		cfg.Sandbox.LXCRootfsBase,
		cfg.Sandbox.LXCDistro,
		cfg.Sandbox.LXCRelease,
	)
	m.providers["lxc"] = lxc
	registerGlobal("lxc", lxc)

	// Register this manager as the process-wide default for event-bus workers.
	setDefaultManager(m)

	return m
}

// RegisterProvider registers a sandbox provider on both this manager and the
// process-wide registry, so event-bus workers can resolve it via SelectProvider.
func (m *Manager) RegisterProvider(name string, provider SandboxProvider) {
	m.mu.Lock()
	m.providers[name] = provider
	m.mu.Unlock()
	registerGlobal(name, provider)
}

// GetProvider returns a sandbox provider by name.
func (m *Manager) GetProvider(name string) (SandboxProvider, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	p, ok := m.providers[name]
	if !ok {
		return nil, fmt.Errorf("sandbox provider %q not registered", name)
	}
	return p, nil
}

// Get returns the sandbox with the given ID and whether it was found.
// Used by the LXC "reuse parent sandbox" exception in the parallel-exec worker.
func (m *Manager) Get(sandboxID string) (*Sandbox, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	sb, ok := m.sandboxes[sandboxID]
	return sb, ok
}

// CreateSandbox creates a sandbox with the given spec.
func (m *Manager) CreateSandbox(spec SandboxSpec) (*Sandbox, error) {
	spec = m.prepareSpec(spec)

	provider, err := m.GetProvider(spec.Type)
	if err != nil {
		return nil, err
	}

	sb, err := provider.Create(spec)
	if err != nil {
		return nil, fmt.Errorf("create sandbox: %w", err)
	}

	m.mu.Lock()
	m.sandboxes[sb.ID] = sb
	m.mu.Unlock()

	// Persist sandbox ID so a daemon crash can be reconciled on restart.
	if m.store != nil {
		if err := m.store.Save(sb); err != nil {
			slog.Warn("sandbox store: save failed", "id", sb.ID, "error", err)
		}
	}

	// P2.2: apply egress allowlist if specified. Best-effort; logs but
	// does not fail the sandbox creation when iptables is unavailable.
	if len(spec.EgressAllowlist) > 0 {
		m.applyEgressAllowlist(sb.ID, sb.Path, spec.EgressAllowlist)
	}

	slog.Info("sandbox created", "id", sb.ID, "type", sb.Type, "permission_profile", spec.PermissionProfile)
	return sb, nil
}

func (m *Manager) prepareSpec(spec SandboxSpec) SandboxSpec {
	spec.PermissionProfile = NormalizePermissionProfile(spec.PermissionProfile)
	// Compatibility only: older Web/API callers may still send "tmpfs".
	// New lightweight sandbox logic uses "docker".
	if spec.Type == "" || spec.Type == "auto" || spec.Type == "tmpfs" {
		spec.Type = "docker"
	}
	// Compatibility only: older Web/API callers may still send "chroot".
	// New persistent sandbox logic uses "lxc".
	if spec.Type == "chroot" {
		spec.Type = "lxc"
	}

	switch spec.PermissionProfile {
	case PermissionProfileStrict:
		spec.Type = "docker-strict"
		spec.SecurityLevel = "strict"
	case PermissionProfilePackageInstall, PermissionProfileBrowser, PermissionProfilePersistent:
		spec.Type = "lxc"
		spec.Persistent = true
	}

	// Inject OS enforcement policy if not already set.
	if spec.SecurityPolicy == nil && m.policy != nil {
		spec.SecurityPolicy = cloneOSPolicy(m.policy)
	}

	if spec.SecurityPolicy != nil {
		switch spec.PermissionProfile {
		case PermissionProfileNetwork, PermissionProfilePackageInstall, PermissionProfileBrowser:
			spec.SecurityPolicy.NetworkNone = false
		case PermissionProfileStrict:
			spec.SecurityPolicy.NetworkNone = true
		}
	}

	if spec.Type == "lxc" && len(spec.InitCommands) == 0 && m.config != nil {
		spec.InitCommands = append([]string(nil), m.config.Sandbox.InitCommands...)
	}
	return spec
}

func NormalizePermissionProfile(profile string) string {
	switch strings.TrimSpace(strings.ToLower(profile)) {
	case "", PermissionProfileDefault:
		return PermissionProfileDefault
	case PermissionProfileStrict:
		return PermissionProfileStrict
	case PermissionProfileNetwork:
		return PermissionProfileNetwork
	case PermissionProfilePackageInstall, "package_install":
		return PermissionProfilePackageInstall
	case PermissionProfileBrowser:
		return PermissionProfileBrowser
	case PermissionProfilePersistent:
		return PermissionProfilePersistent
	default:
		return PermissionProfileDefault
	}
}

func cloneOSPolicy(policy *os_enforce.OSPolicy) *os_enforce.OSPolicy {
	if policy == nil {
		return nil
	}
	return &os_enforce.OSPolicy{
		Seccomp:       policy.Seccomp,
		CapDrop:       append([]string(nil), policy.CapDrop...),
		CapKeep:       append([]string(nil), policy.CapKeep...),
		MaskedPaths:   append([]string(nil), policy.MaskedPaths...),
		ReadonlyPaths: append([]string(nil), policy.ReadonlyPaths...),
		NetworkNone:   policy.NetworkNone,
	}
}

// Exec executes a command in a sandbox.
func (m *Manager) Exec(sandboxID, cmd string, env map[string]string, timeout int) (*ExecResult, error) {
	m.mu.RLock()
	sb, ok := m.sandboxes[sandboxID]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("sandbox %q not found", sandboxID)
	}

	provider, err := m.GetProvider(sb.Type)
	if err != nil {
		return nil, err
	}

	return provider.Exec(sandboxID, cmd, env, timeout)
}

// DestroySandbox destroys a sandbox.
func (m *Manager) DestroySandbox(sandboxID string) error {
	m.mu.Lock()
	sb, ok := m.sandboxes[sandboxID]
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("sandbox %q not found", sandboxID)
	}

	provider, err := m.GetProvider(sb.Type)
	if err != nil {
		return err
	}

	// Stop the egress refresher before destroying so we don't race
	// against an in-flight iptables re-apply on a dead container.
	m.StopEgressRefresher(sandboxID)

	if err := provider.Destroy(sandboxID); err != nil {
		return fmt.Errorf("destroy sandbox: %w", err)
	}

	m.mu.Lock()
	delete(m.sandboxes, sandboxID)
	m.mu.Unlock()

	if m.store != nil {
		if err := m.store.Remove(sandboxID); err != nil {
			slog.Warn("sandbox store: remove failed", "id", sandboxID, "error", err)
		}
	}

	slog.Info("sandbox destroyed", "id", sandboxID)
	return nil
}

// DestroySandboxForce destroys a sandbox, bypassing the Persistent flag
// for LXC. Used by:
//   - session deletion (CloseSession / DestroySession): when a user
//     deletes a session, the LXC rootfs should be torn down too,
//     otherwise the persistent workspace leaks indefinitely.
//   - sandbox_destroy LLM tool: an explicit user request to nuke the
//     sandbox should not leave rootfs behind.
//
// For docker / docker-strict providers this is identical to Destroy
// (their Destroy already removes the container unconditionally).
// DestroySandboxForce removes a sandbox and its backing container
// unconditionally. Used by session deletion and the user-facing
// sandbox_destroy tool.
// RestartSandbox attempts to restart a stopped sandbox via its
// provider's Restart. Returns an error if the provider cannot restart
// (e.g. ephemeral Docker sandboxes) — the caller (HealthChecker) then
// falls back to Destroy.
//
// Only Persistent LXC sandboxes support Restart today. The desktop
// stack is not re-launched here; EnsureDesktop does that lazily on
// the next desktop_* call, after its fast-path probe misses and
// invalidates its own readySet entry.
func (m *Manager) RestartSandbox(sandboxID string) error {
	m.mu.RLock()
	sb, ok := m.sandboxes[sandboxID]
	providerName := sb.Type
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("sandbox %q not found", sandboxID)
	}

	provider, err := m.GetProvider(providerName)
	if err != nil {
		return err
	}

	return provider.Restart(sandboxID)
}

func (m *Manager) DestroySandboxForce(sandboxID string) error {
	m.mu.Lock()
	sb, ok := m.sandboxes[sandboxID]
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("sandbox %q not found", sandboxID)
	}

	provider, err := m.GetProvider(sb.Type)
	if err != nil {
		return err
	}

	// Stop the egress refresher before force-destroying too.
	m.StopEgressRefresher(sandboxID)

	if forceProv, ok := provider.(ForceDestroyer); ok {
		if err := forceProv.DestroyForce(sandboxID); err != nil {
			return fmt.Errorf("destroy sandbox (force): %w", err)
		}
	} else {
		if err := provider.Destroy(sandboxID); err != nil {
			return fmt.Errorf("destroy sandbox: %w", err)
		}
	}

	m.mu.Lock()
	delete(m.sandboxes, sandboxID)
	m.mu.Unlock()

	if m.store != nil {
		if err := m.store.Remove(sandboxID); err != nil {
			slog.Warn("sandbox store: remove failed (force)", "id", sandboxID, "error", err)
		}
	}

	slog.Info("sandbox force-destroyed", "id", sandboxID)
	return nil
}

// ForceDestroyer is implemented by sandbox providers whose Destroy path
// distinguishes "preserve rootfs" (Destroy) from "remove rootfs" (DestroyForce).
// LXC is the only provider that needs this distinction today.
type ForceDestroyer interface {
	DestroyForce(sandboxID string) error
}

// Restore re-hydrates the in-memory sandbox map from the on-disk store
// after a daemon restart. Records whose container has already vanished
// (e.g. docker --rm cleaned up, or manually removed) are reconciled by
// the reaper; this method only re-loads the metadata.
//
// The provider-side in-memory map is also repopulated so that subsequent
// Exec/Destroy calls succeed. For LXC, the container itself is NOT
// restarted here — ReapOrphans handles stop/start reconciliation.
func (m *Manager) Restore() {
	if m.store == nil {
		return
	}
	records := m.store.List()
	if len(records) == 0 {
		return
	}

	m.mu.Lock()
	for _, rec := range records {
		sb := sandboxFromRecord(rec)
		m.sandboxes[sb.ID] = sb
	}
	m.mu.Unlock()

	// Repopulate per-provider maps so Destroy/Exec/Status route correctly.
	// Each provider has its own in-memory `sandboxes` map that we must
	// populate by hand; we use SetPersistent on Docker to mirror the
	// pre-crash Persistent flag (though Docker sandboxes are recreated
	// by the runtime as ephemeral — restore is best-effort).
	for _, rec := range records {
		sb := sandboxFromRecord(rec)
		switch sb.Type {
		case "docker":
			if dp, ok := m.providers["docker"].(*DockerLightProvider); ok {
				dp.mu.Lock()
				dp.sandboxes[sb.ID] = sb
				dp.mu.Unlock()
			}
		case "docker-strict":
			if dp, ok := m.providers["docker-strict"].(*DockerProvider); ok {
				dp.mu.Lock()
				dp.sandboxes[sb.ID] = sb
				dp.mu.Unlock()
			}
		case "lxc":
			if lp, ok := m.providers["lxc"].(*LXCPersistentProvider); ok {
				lp.mu.Lock()
				lp.sandboxes[sb.ID] = sb
				if sb.Persistent {
					lp.initialized[sb.ID] = true
				}
				lp.mu.Unlock()
			}
		}
	}

	slog.Info("sandbox manager restored from disk", "count", len(records))
}

// CleanupOnShutdown is invoked from the daemon's signal handler (after
// DropPrivileges). It implements the LXC-vs-Docker split:
//
//   - LXC (persistent): lxc-stop, preserve rootfs. The next session can
//     lxc-start the same container and resume work.
//   - Docker / docker-strict (non-persistent): docker rm -f. docker-strict
//     has no --rm flag and would leak in 'exited' state otherwise.
//     docker light already self-cleans via --rm but the call is idempotent.
//
// Failures per-container are logged; the daemon proceeds to HTTP shutdown
// regardless. Returns nil unless the whole sweep is fundamentally broken.
func (m *Manager) CleanupOnShutdown(ctx context.Context) error {
	if m == nil {
		return nil
	}
	m.stopAllLXC(ctx)
	m.destroyAllDocker(ctx)
	return nil
}

// Status returns sandbox status.
func (m *Manager) Status(sandboxID string) (*Sandbox, error) {
	m.mu.RLock()
	sb, ok := m.sandboxes[sandboxID]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("sandbox %q not found", sandboxID)
	}

	provider, err := m.GetProvider(sb.Type)
	if err != nil {
		return nil, err
	}

	return provider.Status(sandboxID)
}

// ListSandboxes returns all managed sandboxes.
func (m *Manager) ListSandboxes() []*Sandbox {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]*Sandbox, 0, len(m.sandboxes))
	for _, sb := range m.sandboxes {
		result = append(result, sb)
	}
	return result
}

// SelectSandbox chooses the appropriate sandbox type for a task.
// Selection priority:
//  1. User explicit setting (task.SandboxType)
//  2. High-risk commands → docker-strict (strong isolation)
//  3. Persistence-needed commands → LXC (persistent filesystem)
//  4. Agent default config
//  5. Fallback → docker (lightweight, non-persistent)
func SelectSandbox(task *clawless.Task, agentCfg *clawless.AgentConfig) string {
	// 1. User explicit setting
	if task.SandboxType != "" && task.SandboxType != "auto" {
		return task.SandboxType
	}

	// 2. High-risk commands → docker-strict (strongest isolation)
	if isHighRisk(task.Command) {
		return "docker-strict"
	}

	// 3. Commands needing persistent environment → LXC
	if needsPersistence(task.Command) {
		return "lxc"
	}

	// 4. Agent default config
	if agentCfg != nil && agentCfg.DefaultSandbox != "" {
		return agentCfg.DefaultSandbox
	}

	// 5. Default: docker light (lightweight, non-persistent)
	return "docker"
}

// isHighRisk returns true if the command is considered high-risk.
func isHighRisk(command string) bool {
	highRiskPatterns := []string{
		"rm -rf", "mkfs", "dd if=", "fdisk", "wipefs",
		"curl.*|.*bash", "wget.*|.*sh",
		"sudo", "chmod 777", "chown root",
		"iptables -F", "shutdown", "reboot",
	}
	for _, p := range highRiskPatterns {
		if containsPattern(command, p) {
			return true
		}
	}
	return false
}

// needsPersistence returns true if the command needs a persistent environment.
func needsPersistence(command string) bool {
	persistPatterns := []string{
		"git clone", "git pull", "git fetch",
		"go build", "npm install", "pip install",
		"cargo build", "mvn package", "gradle build",
		"make", "cmake",
		"headless browser", "browser automation", "rendered fetch",
		"rendered web search", "js rendering", "javascript rendering",
		"web_fetch_rendered", "web_search_rendered",
	}
	// P2: all browser_* tools (tools_browser_v2.go) want a persistent LXC
	// sandbox so the in-sandbox Playwright helper survives across calls in
	// the same session. Prefix match covers future additions.
	if strings.Contains(command, "browser_") {
		return true
	}
	for _, p := range persistPatterns {
		if containsPattern(command, p) {
			return true
		}
	}
	return false
}

func containsPattern(s, pattern string) bool {
	return len(s) > 0 && len(pattern) > 0 && strings.Contains(strings.ToLower(s), strings.ToLower(pattern))
}

// HostWorkspacePath returns the host-side path to the sandbox's workspace root
// (the directory that contains the `workspace/` subdirectory), or "" when the
// sandbox has no host filesystem workspace.
//
// LXC persistent sandboxes expose a real rootfs path via RootfsPath(); docker
// / docker-strict containers do not, and their workspace lives in-container
// (e.g. /workspace). Callers that need to run host-FS operations (e.g. the
// checkpoint host backend) should fall back to in-container execution when
// this returns "".
func (m *Manager) HostWorkspacePath(sandboxID string) string {
	m.mu.RLock()
	sb, ok := m.sandboxes[sandboxID]
	m.mu.RUnlock()
	if !ok {
		return ""
	}
	provider, err := m.GetProvider(sb.Type)
	if err != nil {
		return ""
	}
	type rootfsResolver interface {
		RootfsPath(sandboxID string) string
	}
	rr, ok := provider.(rootfsResolver)
	if !ok {
		return ""
	}
	return rr.RootfsPath(sandboxID)
}
