package cache

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
)

// Manager manages local /tmp/agentd caching.
type Manager struct {
	basePath   string
	maxSize    int64
	sessions   map[string]*SessionCache
	mu         sync.RWMutex
	syncTicker *time.Ticker
	stopCh     chan struct{}
	clawless   *clawless.Client // optional; nil = local-only mode
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

// SetClawlessClient wires the web-API client. Without this the manager
// runs in local-only mode (no remote sync).
func (m *Manager) SetClawlessClient(c *clawless.Client) {
	m.clawless = c
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

// SyncSession syncs a single session to the ClawLess web layer.
//
// P0.4: Previously a stub ("Phase 5"). Now reads the local cache file
// and PUTs it to /api/agentd/v1/sessions/:id via the clawless client.
// Failures are logged but do not block syncAll; the file stays Dirty.
// If the clawless client is unset (local-only mode), this is a no-op.
func (m *Manager) SyncSession(sessionID string) error {
	if m.clawless == nil {
		// Local-only mode; nothing to sync.
		return nil
	}

	m.mu.RLock()
	path := filepath.Join(m.basePath, "sessions", sessionID+".json")
	m.mu.RUnlock()

	data, err := os.ReadFile(path)
	if err != nil {
		slog.Debug("sync: no local session blob", "session_id", sessionID, "error", err)
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Parse as a Session so UpdateSession can marshal it back. If the
	// local blob isn't a Session struct (e.g., a raw cache snapshot),
	// skip the sync — we only push structured session data upstream.
	var sess clawless.Session
	if err := json.Unmarshal(data, &sess); err != nil || sess.ID == "" {
		slog.Debug("sync: local blob is not a Session; skipping", "session_id", sessionID)
		return nil
	}

	if err := m.clawless.UpdateSession(ctx, &sess); err != nil {
		slog.Warn("sync: UpdateSession failed", "session_id", sessionID, "error", err)
		return err
	}

	m.mu.Lock()
	if sc, ok := m.sessions[sessionID]; ok {
		sc.Dirty = false
		sc.LastSync = time.Now()
	}
	m.mu.Unlock()

	slog.Info("session synced upstream", "session_id", sessionID, "bytes", len(data))
	return nil
}

// CompressSession gzip-compresses the local session blob.
//
// P0.4: Previously a stub ("Phase 5"). Now writes a .json.gz alongside
// the .json and returns the compressed size. Compression is opt-in —
// callers that want the original (e.g., SyncSession) still read .json.
func (m *Manager) CompressSession(sessionID string) error {
	m.mu.RLock()
	path := filepath.Join(m.basePath, "sessions", sessionID+".json")
	m.mu.RUnlock()

	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	var buf bytes.Buffer
	gz, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if _, err := gz.Write(data); err != nil {
		return err
	}
	if err := gz.Close(); err != nil {
		return err
	}

	compressedPath := path + ".gz"
	if err := os.WriteFile(compressedPath, buf.Bytes(), 0o640); err != nil {
		return err
	}

	m.mu.Lock()
	if sc, ok := m.sessions[sessionID]; ok {
		sc.SummaryPath = compressedPath
	}
	m.mu.Unlock()

	ratio := float64(buf.Len()) / float64(len(data)) * 100
	slog.Info("session compressed",
		"session_id", sessionID,
		"raw_bytes", len(data),
		"compressed_bytes", buf.Len(),
		"ratio_pct", int(ratio),
	)
	return nil
}

// ReadCompressedSession reads a gzip-compressed session blob. Returns
// the original error from os/gzip if the .gz doesn't exist.
func (m *Manager) ReadCompressedSession(sessionID string) ([]byte, error) {
	m.mu.RLock()
	path := filepath.Join(m.basePath, "sessions", sessionID+".json.gz")
	m.mu.RUnlock()

	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	return io.ReadAll(gz)
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
