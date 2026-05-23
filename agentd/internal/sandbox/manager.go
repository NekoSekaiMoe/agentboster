package sandbox

import (
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/config"
)

// SandboxProvider is the interface for sandbox implementations.
type SandboxProvider interface {
	// Create creates a new sandbox.
	Create(spec SandboxSpec) (*Sandbox, error)
	// Exec executes a command inside the sandbox.
	Exec(sandboxID string, cmd string, env map[string]string, timeout int) (*ExecResult, error)
	// Destroy destroys the sandbox.
	Destroy(sandboxID string) error
	// Status returns the current sandbox status.
	Status(sandboxID string) (*Sandbox, error)
}

// SandboxSpec defines how to create a sandbox.
type SandboxSpec struct {
	Type        string            // tmpfs, chroot, docker
	AgentID     string
	Persistent  bool
	Image       string            // Docker image
	RootFSPath  string            // chroot root filesystem path
	Mounts      []Mount
	Environment map[string]string
	WorkDir     string
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
	Path       string // local path or container ID
	Status     string // creating, ready, destroyed
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
}

// NewManager creates a new sandbox manager.
func NewManager(cfg *config.Config) *Manager {
	m := &Manager{
		providers: make(map[string]SandboxProvider),
		sandboxes: make(map[string]*Sandbox),
		config:    cfg,
	}

	// Register built-in providers
	m.providers["tmpfs"] = NewTmpfsProvider(cfg.Sandbox.TmpfsSize, cfg.Sandbox.ChrootBase)
	// Phase 4: m.providers["chroot"] = NewChrootProvider(cfg.Sandbox.ChrootBase)
	// Phase 4: m.providers["docker"] = NewDockerProvider(cfg.Sandbox.DockerSocket)

	return m
}

// RegisterProvider registers a sandbox provider.
func (m *Manager) RegisterProvider(name string, provider SandboxProvider) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.providers[name] = provider
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

// CreateSandbox creates a sandbox with the given spec.
func (m *Manager) CreateSandbox(spec SandboxSpec) (*Sandbox, error) {
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

// SelectSandbox chooses the appropriate sandbox type for a task (replicating tasks.md 5.3).
func SelectSandbox(task *clawless.Task, agentCfg *clawless.AgentConfig) string {
	// User explicit setting
	if task.SandboxType != "" && task.SandboxType != "auto" {
		return task.SandboxType
	}

	// Auto-select based on command risk and persistence needs
	if isHighRisk(task.Command) {
		return "docker"
	}
	if needsPersistence(task.Command) {
		return "chroot"
	}
	// Fall back to agent default
	if agentCfg.DefaultSandbox != "" {
		return agentCfg.DefaultSandbox
	}
	return "tmpfs"
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
	}
	for _, p := range persistPatterns {
		if containsPattern(command, p) {
			return true
		}
	}
	return false
}

func containsPattern(s, pattern string) bool {
	// Simple substring match — L0 engine handles precise matching
	return len(s) > 0 && len(pattern) > 0 && contains(s, pattern)
}

func contains(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
