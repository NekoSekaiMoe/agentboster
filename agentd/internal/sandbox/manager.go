//go:build linux
// +build linux

package sandbox

import (
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/config"
	"github.com/clawless/agentd/internal/security/l0_rules"
	"github.com/clawless/agentd/internal/security/os_enforce"
)

// SandboxProvider is the interface for sandbox implementations.
type SandboxProvider interface {
	Create(spec SandboxSpec) (*Sandbox, error)
	Exec(sandboxID string, cmd string, env map[string]string, timeout int) (*ExecResult, error)
	Destroy(sandboxID string) error
	Status(sandboxID string) (*Sandbox, error)
}

// SandboxSpec defines how to create a sandbox.
type SandboxSpec struct {
	Type           string
	AgentID        string
	Persistent     bool     // true = LXC persistent container
	Distro         string   // LXC distro (default: alpine)
	Release        string   // LXC release (default: 3.21)
	InitCommands   []string // LXC init commands after first boot
	CPULimit       float64  // CPU cores limit (Docker: 0.25, LXC: 1.0)
	MemoryLimit    int64    // Memory limit in bytes (Docker: 256MB, LXC: 512MB)
	Image          string   // Docker image
	Mounts         []Mount
	Environment    map[string]string
	WorkDir        string
	SecurityLevel  string               // "light" (default) or "strict" (Docker only)
	UserSpecified  bool                 // true if user explicitly specified sandbox type
	SecurityPolicy *os_enforce.OSPolicy // OS-level enforcement (nil = skip)
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
}

// NewManager creates a new sandbox manager with all built-in providers.
func NewManager(cfg *config.Config, l0Engine *l0_rules.Engine) *Manager {
	m := &Manager{
		providers: make(map[string]SandboxProvider),
		sandboxes: make(map[string]*Sandbox),
		config:    cfg,
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
	// Inject OS enforcement policy if not already set and not docker-strict
	if spec.SecurityPolicy == nil && m.policy != nil && spec.Type != "docker-strict" {
		spec.SecurityPolicy = m.policy
	}
	if spec.Type == "lxc" && len(spec.InitCommands) == 0 && m.config != nil {
		spec.InitCommands = append([]string(nil), m.config.Sandbox.InitCommands...)
	}

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

	slog.Info("sandbox created", "id", sb.ID, "type", sb.Type)
	return sb, nil
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

	if err := provider.Destroy(sandboxID); err != nil {
		return fmt.Errorf("destroy sandbox: %w", err)
	}

	m.mu.Lock()
	delete(m.sandboxes, sandboxID)
	m.mu.Unlock()

	slog.Info("sandbox destroyed", "id", sandboxID)
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
