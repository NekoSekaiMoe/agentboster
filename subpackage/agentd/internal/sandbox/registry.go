//go:build linux
// +build linux

package sandbox

import (
	"fmt"
	"sync"
)

// globalRegistry is a process-wide registry of sandbox providers, populated by
// Manager.NewManager at startup. It exists so that handlers without a Manager
// reference (e.g. event-bus workers) can resolve a provider by name via
// SelectProvider.
var globalRegistry = struct {
	mu        sync.RWMutex
	providers map[string]SandboxProvider
}{providers: make(map[string]SandboxProvider)}

// registerGlobal adds (or replaces) a provider in the process-wide registry.
func registerGlobal(name string, provider SandboxProvider) {
	globalRegistry.mu.Lock()
	defer globalRegistry.mu.Unlock()
	globalRegistry.providers[name] = provider
}

// SelectProvider returns the registered provider with the given name.
// Returns an error if no such provider is registered.
func SelectProvider(name string) (SandboxProvider, error) {
	globalRegistry.mu.RLock()
	defer globalRegistry.mu.RUnlock()
	p, ok := globalRegistry.providers[name]
	if !ok {
		return nil, fmt.Errorf("sandbox provider %q not registered", name)
	}
	return p, nil
}

// HasProvider reports whether a provider with the given name is registered.
func HasProvider(name string) bool {
	globalRegistry.mu.RLock()
	defer globalRegistry.mu.RUnlock()
	_, ok := globalRegistry.providers[name]
	return ok
}

// defaultManager is the most recently constructed Manager, set by
// NewManager. The event-bus workers (e.g. parallel exec) need a way to look
// up an existing sandbox by ID (the LXC "reuse parent sandbox" exception),
// so a Manager reference is exposed here for the same reason SelectProvider
// exists: callers in the worker pool don't carry a Manager dependency.
var defaultManager struct {
	mu sync.RWMutex
	m  *Manager
}

// setDefaultManager records m as the process-wide default Manager.
func setDefaultManager(m *Manager) {
	defaultManager.mu.Lock()
	defer defaultManager.mu.Unlock()
	defaultManager.m = m
}

// DefaultManager returns the process-wide default Manager, or nil if no
// Manager has been constructed yet.
func DefaultManager() *Manager {
	defaultManager.mu.RLock()
	defer defaultManager.mu.RUnlock()
	return defaultManager.m
}
