package session

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// SessionData is the serializable form of an agent session context.
type SessionData struct {
	SessionID       string         `json:"session_id"`
	AgentID         string         `json:"agent_id"`
	SandboxID       string         `json:"sandbox_id"`
	SandboxType     string         `json:"sandbox_type"`
	SandboxPath     string         `json:"sandbox_path"`
	Model           string         `json:"model"`
	MaxSteps        int            `json:"max_steps"`
	SystemPrompt    string         `json:"system_prompt"`
	StartTime       time.Time      `json:"start_time"`
	LastAccessTime  time.Time      `json:"last_access_time"`
	SandboxState    SandboxData    `json:"sandbox_state"`
	SessionSummary  string         `json:"session_summary"`
	RecentToolCalls []ToolRecord   `json:"recent_tool_calls"`
	WorkspaceID     string         `json:"workspace_id"`
	ProjectID       string         `json:"project_id"`
}

type SandboxData struct {
	Type        string `json:"type"`
	Path        string `json:"path"`
	AvailableMB int64  `json:"available_mb"`
}

type ToolRecord struct {
	Tool    string    `json:"tool"`
	Args    string    `json:"args"`
	Result  string    `json:"result"`
	Success bool      `json:"success"`
	Time    time.Time `json:"time"`
}

// Store persists session data to disk and manages session lifecycle.
type Store struct {
	mu          sync.RWMutex
	sessions    map[string]*SessionData
	storePath   string
	maxCount    int
	timeout     time.Duration
	accessOrder []string
}

// NewStore creates a new session store.
func NewStore(storePath string, maxCount int, timeout time.Duration) (*Store, error) {
	if err := os.MkdirAll(storePath, 0o750); err != nil {
		return nil, fmt.Errorf("create session store dir: %w", err)
	}

	s := &Store{
		sessions:    make(map[string]*SessionData),
		storePath:   storePath,
		maxCount:    maxCount,
		timeout:     timeout,
		accessOrder: make([]string, 0),
	}

	if err := s.loadAll(); err != nil {
		slog.Warn("failed to load existing sessions", "error", err)
	}

	return s, nil
}

// Get returns session data by ID.
func (s *Store) Get(sessionID string) (*SessionData, bool) {
	s.mu.RLock()
	ctx, ok := s.sessions[sessionID]
	s.mu.RUnlock()

	if ok {
		s.touch(sessionID)
	}
	return ctx, ok
}

// Put stores session data.
func (s *Store) Put(sessionID string, data *SessionData) error {
	s.mu.Lock()
	s.sessions[sessionID] = data
	s.touchLocked(sessionID)
	s.mu.Unlock()

	return s.save(sessionID, data)
}

// Delete removes a session from store and disk.
func (s *Store) Delete(sessionID string) error {
	s.mu.Lock()
	delete(s.sessions, sessionID)
	s.removeFromOrderLocked(sessionID)
	s.mu.Unlock()

	path := s.sessionPath(sessionID)
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("delete session file: %w", err)
	}

	slog.Info("session deleted", "session_id", sessionID)
	return nil
}

// List returns session info sorted by most recent first.
func (s *Store) List(limit int) []SessionInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()

	infos := make([]SessionInfo, 0, len(s.accessOrder))
	for i := len(s.accessOrder) - 1; i >= 0; i-- {
		id := s.accessOrder[i]
		if data, ok := s.sessions[id]; ok {
			infos = append(infos, SessionInfo{
				ID:        id,
				AgentID:   data.AgentID,
				CreatedAt: data.StartTime,
			})
			if len(infos) >= limit {
				break
			}
		}
	}
	return infos
}

// Count returns the number of sessions.
func (s *Store) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.sessions)
}

// ArchiveOldest marks oldest sessions for removal beyond maxCount.
func (s *Store) ArchiveOldest() []string {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.sessions) <= s.maxCount {
		return nil
	}

	sort.Strings(s.accessOrder)

	toArchive := make([]string, 0)
	for len(s.sessions)-len(toArchive) > s.maxCount && len(s.accessOrder) > 0 {
		oldest := s.accessOrder[0]
		s.accessOrder = s.accessOrder[1:]
		if _, ok := s.sessions[oldest]; ok {
			toArchive = append(toArchive, oldest)
		}
	}

	return toArchive
}

// CleanupExpired removes sessions idle longer than timeout.
func (s *Store) CleanupExpired() []string {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	expired := make([]string, 0)

	for id, data := range s.sessions {
		if now.Sub(data.LastAccessTime) > s.timeout {
			expired = append(expired, id)
		}
	}

	for _, id := range expired {
		delete(s.sessions, id)
		s.removeFromOrderLocked(id)
	}

	return expired
}

func (s *Store) save(sessionID string, data *SessionData) error {
	path := s.sessionPath(sessionID)
	raw, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("marshal session: %w", err)
	}

	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, raw, 0o640); err != nil {
		return fmt.Errorf("write session file: %w", err)
	}

	return os.Rename(tmpPath, path)
}

// Load reads session data from disk.
func (s *Store) Load(sessionID string) (*SessionData, error) {
	path := s.sessionPath(sessionID)
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read session file: %w", err)
	}

	var data SessionData
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, fmt.Errorf("unmarshal session: %w", err)
	}

	s.mu.Lock()
	s.sessions[sessionID] = &data
	s.touchLocked(sessionID)
	s.mu.Unlock()

	return &data, nil
}

func (s *Store) loadAll() error {
	entries, err := os.ReadDir(s.storePath)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if filepath.Ext(entry.Name()) != ".json" {
			continue
		}

		sessionID := entry.Name()[:len(entry.Name())-5]
		if _, err := s.Load(sessionID); err != nil {
			slog.Warn("failed to load session", "session_id", sessionID, "error", err)
		}
	}

	slog.Info("session store loaded", "count", len(s.sessions), "path", s.storePath)
	return nil
}

func (s *Store) sessionPath(sessionID string) string {
	return filepath.Join(s.storePath, sessionID+".json")
}

func (s *Store) touch(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.touchLocked(sessionID)
}

func (s *Store) touchLocked(sessionID string) {
	s.removeFromOrderLocked(sessionID)
	s.accessOrder = append(s.accessOrder, sessionID)
}

func (s *Store) removeFromOrderLocked(sessionID string) {
	filtered := s.accessOrder[:0]
	for _, id := range s.accessOrder {
		if id != sessionID {
			filtered = append(filtered, id)
		}
	}
	s.accessOrder = filtered
}

// SessionInfo holds minimal session metadata for listing.
type SessionInfo struct {
	ID        string    `json:"id"`
	AgentID   string    `json:"agent_id"`
	CreatedAt time.Time `json:"created_at"`
}
