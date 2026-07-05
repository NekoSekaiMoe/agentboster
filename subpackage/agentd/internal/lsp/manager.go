package lsp

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Manager manages LSP server instances for sandboxes.
// Each sandbox can have one LSP server per project type.
type Manager struct {
	servers     map[string]*serverEntry // key: sandboxID:projectType
	serversLock sync.RWMutex
	execFunc    ExecFunc // Function to execute commands in sandbox
}

// ExecFunc executes a command in a sandbox and returns the result.
// This is provided by the sandbox manager.
type ExecFunc func(sandboxID, cmd string, env map[string]string, timeout int) (stdout, stderr string, exitCode int, err error)

// serverEntry tracks an LSP server instance.
type serverEntry struct {
	client     *Client
	sandboxID  string
	projectType ProjectType
	rootPath   string
	lastAccess time.Time
	mu         sync.Mutex
}

// NewManager creates a new LSP manager.
func NewManager(execFunc ExecFunc) *Manager {
	m := &Manager{
		servers:  make(map[string]*serverEntry),
		execFunc: execFunc,
	}

	// Start cleanup goroutine
	go m.cleanupLoop()

	return m
}

// GetOrStart returns an LSP client for the given sandbox and project path.
// It detects the project type, installs the LSP server if needed, and starts it.
func (m *Manager) GetOrStart(ctx context.Context, sandboxID, projectPath string) (*Client, ProjectType, error) {
	// Detect project type
	ptype := DetectProjectType(projectPath)
	if ptype == ProjectTypeUnknown {
		return nil, ptype, fmt.Errorf("could not detect project type in %s", projectPath)
	}

	key := m.makeKey(sandboxID, ptype)

	// Check if we already have a running server
	m.serversLock.RLock()
	entry, exists := m.servers[key]
	m.serversLock.RUnlock()

	if exists {
		entry.mu.Lock()
		entry.lastAccess = time.Now()
		client := entry.client
		entry.mu.Unlock()
		return client, ptype, nil
	}

	// Need to start a new server
	m.serversLock.Lock()
	defer m.serversLock.Unlock()

	// Double-check after acquiring write lock
	if entry, exists := m.servers[key]; exists {
		entry.mu.Lock()
		entry.lastAccess = time.Now()
		client := entry.client
		entry.mu.Unlock()
		return client, ptype, nil
	}

	// Get server config
	config, ok := GetServerConfig(ptype)
	if !ok {
		return nil, ptype, fmt.Errorf("no LSP server configured for %s", ptype)
	}

	// Check if LSP server is installed, install if not
	if err := m.ensureInstalled(sandboxID, config); err != nil {
		return nil, ptype, fmt.Errorf("failed to install LSP server: %w", err)
	}

	// Start the LSP server
	client, err := m.startServer(ctx, sandboxID, projectPath, config)
	if err != nil {
		return nil, ptype, fmt.Errorf("failed to start LSP server: %w", err)
	}

	// Store the entry
	entry = &serverEntry{
		client:      client,
		sandboxID:   sandboxID,
		projectType: ptype,
		rootPath:    projectPath,
		lastAccess:  time.Now(),
	}
	m.servers[key] = entry

	slog.Info("LSP server started",
		"sandbox", sandboxID,
		"type", ptype,
		"path", projectPath,
	)

	return client, ptype, nil
}

// Stop stops the LSP server for a sandbox and project type.
func (m *Manager) Stop(sandboxID string, ptype ProjectType) {
	key := m.makeKey(sandboxID, ptype)

	m.serversLock.Lock()
	entry, exists := m.servers[key]
	if exists {
		delete(m.servers, key)
	}
	m.serversLock.Unlock()

	if exists {
		entry.mu.Lock()
		client := entry.client
		entry.mu.Unlock()

		if err := client.Close(); err != nil {
			slog.Warn("LSP server close error",
				"sandbox", sandboxID,
				"type", ptype,
				"error", err,
			)
		}
		slog.Debug("LSP server stopped", "sandbox", sandboxID, "type", ptype)
	}
}

// StopAll stops all LSP servers for a sandbox.
func (m *Manager) StopAll(sandboxID string) {
	m.serversLock.Lock()
	var toStop []*serverEntry
	for key, entry := range m.servers {
		if entry.sandboxID == sandboxID {
			toStop = append(toStop, entry)
			delete(m.servers, key)
		}
	}
	m.serversLock.Unlock()

	for _, entry := range toStop {
		entry.mu.Lock()
		client := entry.client
		ptype := entry.projectType
		entry.mu.Unlock()

		if err := client.Close(); err != nil {
			slog.Warn("LSP server close error",
				"sandbox", sandboxID,
				"type", ptype,
				"error", err,
			)
		}
	}

	if len(toStop) > 0 {
		slog.Debug("LSP servers stopped", "sandbox", sandboxID, "count", len(toStop))
	}
}

// Shutdown stops all LSP servers.
func (m *Manager) Shutdown() {
	m.serversLock.Lock()
	entries := make([]*serverEntry, 0, len(m.servers))
	for _, entry := range m.servers {
		entries = append(entries, entry)
	}
	m.servers = make(map[string]*serverEntry)
	m.serversLock.Unlock()

	for _, entry := range entries {
		entry.mu.Lock()
		client := entry.client
		entry.mu.Unlock()

		if err := client.Close(); err != nil {
			slog.Warn("LSP server close error",
				"sandbox", entry.sandboxID,
				"type", entry.projectType,
				"error", err,
			)
		}
	}

	slog.Info("LSP manager shutdown complete", "count", len(entries))
}

// ensureInstalled checks if the LSP server is installed, and installs it if not.
func (m *Manager) ensureInstalled(sandboxID string, config ServerConfig) error {
	// Check if the command exists
	checkCmd := fmt.Sprintf("command -v %s", config.Command)
	_, _, exitCode, err := m.execFunc(sandboxID, checkCmd, nil, 5)
	if err != nil {
		return fmt.Errorf("failed to check if %s is installed: %w", config.Command, err)
	}

	if exitCode == 0 {
		// Already installed
		return nil
	}

	// Need to install
	slog.Info("Installing LSP server",
		"sandbox", sandboxID,
		"command", config.Command,
	)

	for i, installCmd := range config.InstallCommands {
		stdout, stderr, exitCode, err := m.execFunc(sandboxID, installCmd, nil, 300)
		if err != nil {
			return fmt.Errorf("install command %d failed: %w", i, err)
		}
		if exitCode != 0 {
			slog.Warn("Install command failed",
				"sandbox", sandboxID,
				"cmd", installCmd,
				"exitCode", exitCode,
				"stdout", stdout,
				"stderr", stderr,
			)
			return fmt.Errorf("install command %d exited with %d", i, exitCode)
		}
	}

	// Verify installation
	_, _, exitCode, err = m.execFunc(sandboxID, checkCmd, nil, 5)
	if err != nil || exitCode != 0 {
		return fmt.Errorf("LSP server still not found after installation")
	}

	slog.Info("LSP server installed successfully",
		"sandbox", sandboxID,
		"command", config.Command,
	)

	return nil
}

// startServer starts an LSP server process inside the sandbox.
// The LSP server runs inside the LXC container and communicates with the host
// via lxc-attach stdio bridging.
func (m *Manager) startServer(ctx context.Context, sandboxID, rootPath string, config ServerConfig) (*Client, error) {
	// Convert rootPath to file:// URI
	// For container-internal LSP, use the path as seen from inside the container
	rootURI := "file://" + rootPath

	slog.Info("Starting LSP server inside sandbox",
		"sandbox", sandboxID,
		"command", config.Command,
		"rootPath", rootPath,
	)

	// Create sandbox client that runs LSP inside the container
	sandboxClient, err := NewSandboxClient(
		ctx,
		sandboxID,
		config.Command,
		config.Args,
		rootPath,  // working directory inside container
		rootURI,
		config.LanguageID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create sandbox LSP client: %w", err)
	}

	// Initialize the client
	initCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	if err := sandboxClient.Initialize(initCtx); err != nil {
		sandboxClient.Close()
		return nil, fmt.Errorf("failed to initialize LSP client: %w", err)
	}

	// Return the underlying client (SandboxClient wraps Client and provides the same interface)
	return sandboxClient.client, nil
}

// cleanupLoop periodically closes idle LSP servers.
func (m *Manager) cleanupLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		m.cleanupIdle()
	}
}

// cleanupIdle closes LSP servers that haven't been accessed recently.
func (m *Manager) cleanupIdle() {
	idleThreshold := 10 * time.Minute
	now := time.Now()

	m.serversLock.Lock()
	var toClose []string
	for key, entry := range m.servers {
		entry.mu.Lock()
		idle := now.Sub(entry.lastAccess)
		entry.mu.Unlock()

		if idle > idleThreshold {
			toClose = append(toClose, key)
		}
	}

	var entries []*serverEntry
	for _, key := range toClose {
		if entry, exists := m.servers[key]; exists {
			entries = append(entries, entry)
			delete(m.servers, key)
		}
	}
	m.serversLock.Unlock()

	for _, entry := range entries {
		entry.mu.Lock()
		client := entry.client
		sandboxID := entry.sandboxID
		ptype := entry.projectType
		entry.mu.Unlock()

		if err := client.Close(); err != nil {
			slog.Warn("LSP cleanup close error",
				"sandbox", sandboxID,
				"type", ptype,
				"error", err,
			)
		} else {
			slog.Debug("LSP server closed (idle)",
				"sandbox", sandboxID,
				"type", ptype,
			)
		}
	}
}

// makeKey generates a unique key for a sandbox/project type combination.
func (m *Manager) makeKey(sandboxID string, ptype ProjectType) string {
	return fmt.Sprintf("%s:%s", sandboxID, ptype)
}
