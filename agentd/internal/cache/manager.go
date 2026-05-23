package cache

import (
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Manager manages local /tmp/agentd caching.
type Manager struct {
	basePath   string
	maxSize    int64
	sessions   map[string]*SessionCache
	mu         sync.RWMutex
	syncTicker *time.Ticker
	stopCh     chan struct{}
}

// SessionCache holds cached session data.
type SessionCache struct {
	SessionID   string
	JSONPath    string
	SummaryPath string
	Size        int64
	Dirty       bool
	LastSync    time.Time
}

// NewManager creates a new cache manager.
func NewManager(basePath string, maxSize int64) *Manager {
	return &Manager{
		basePath: basePath,
		maxSize:  maxSize,
		sessions: make(map[string]*SessionCache),
		stopCh:   make(chan struct{}),
	}
}

// Init creates the cache directory if it doesn't exist.
func (m *Manager) Init() error {
	return os.MkdirAll(m.basePath, 0o750)
}

// StartPeriodicSync starts the background sync goroutine.
func (m *Manager) StartPeriodicSync(interval time.Duration) {
	m.syncTicker = time.NewTicker(interval)
	go func() {
		for {
			select {
			case <-m.syncTicker.C:
				m.syncAll()
			case <-m.stopCh:
				return
			}
		}
	}()
	slog.Info("cache sync started", "interval", interval)
}

// StopPeriodicSync stops the background sync.
func (m *Manager) StopPeriodicSync() {
	if m.syncTicker != nil {
		m.syncTicker.Stop()
	}
	close(m.stopCh)
}

// LoadSession loads a session from local cache.
func (m *Manager) LoadSession(sessionID string) ([]byte, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	path := filepath.Join(m.basePath, "sessions", sessionID+".json")
	return os.ReadFile(path)
}

// SaveSession saves a session to local cache.
func (m *Manager) SaveSession(sessionID string, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	dir := filepath.Join(m.basePath, "sessions")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}

	path := filepath.Join(dir, sessionID+".json")
	if err := os.WriteFile(path, data, 0o640); err != nil {
		return err
	}

	m.sessions[sessionID] = &SessionCache{
		SessionID: sessionID,
		JSONPath:  path,
		Size:      int64(len(data)),
		Dirty:     false,
		LastSync:  time.Now(),
	}
	return nil
}

// SyncSession syncs a single session to ClawLess (stub — Phase 5).
func (m *Manager) SyncSession(sessionID string) error {
	slog.Info("syncing session", "session_id", sessionID)
	// Phase 5: push to ClawLess API
	return nil
}

// CompressSession compresses a session (stub — Phase 5).
func (m *Manager) CompressSession(sessionID string) error {
	slog.Info("compressing session", "session_id", sessionID)
	// Phase 5: gzip compress
	return nil
}

func (m *Manager) syncAll() {
	m.mu.RLock()
	ids := make([]string, 0, len(m.sessions))
	for id, sc := range m.sessions {
		if sc.Dirty {
			ids = append(ids, id)
		}
	}
	m.mu.RUnlock()

	for _, id := range ids {
		if err := m.SyncSession(id); err != nil {
			slog.Error("sync session failed", "session_id", id, "error", err)
		}
	}
}
