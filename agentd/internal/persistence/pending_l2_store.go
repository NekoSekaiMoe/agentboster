package persistence

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// PendingL2State represents a task awaiting L2 authorization.
type PendingL2State struct {
	TaskID      string    `json:"task_id"`
	SessionID   string    `json:"session_id"`
	AgentID     string    `json:"agent_id"`
	Command     string    `json:"command"`
	Score       float64   `json:"score"`
	Reason      string    `json:"reason"`
	Level       string    `json:"level"`
	DecisionID  string    `json:"decision_id"`
	RequestedAt time.Time `json:"requested_at"`
}

// PendingL2Store persists pending L2 authorization states to disk.
// On daemon restart, ClawLess can query ListAll() to re-surface pending decisions.
type PendingL2Store struct {
	mu      sync.RWMutex
	states  map[string]*PendingL2State // key = task_id
	dir     string
}

// NewPendingL2Store creates a pending L2 store under the given directory.
func NewPendingL2Store(dir string) (*PendingL2Store, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("create pending_l2 dir: %w", err)
	}
	s := &PendingL2Store{
		states: make(map[string]*PendingL2State),
		dir:    dir,
	}
	return s, nil
}

// PendingL2Path returns the default path for the pending L2 store.
func PendingL2Path(base string) string {
	return filepath.Join(base, "pending_l2")
}

// Save persists a pending L2 state to memory and disk.
func (s *PendingL2Store) Save(state *PendingL2State) error {
	s.mu.Lock()
	s.states[state.TaskID] = state
	s.mu.Unlock()
	return s.writeToDisk(state)
}

// Remove deletes a pending L2 state (after user confirms or rejects).
func (s *PendingL2Store) Remove(taskID string) error {
	s.mu.Lock()
	delete(s.states, taskID)
	s.mu.Unlock()
	return os.Remove(s.statePath(taskID))
}

// Load returns the pending L2 state for the given task ID.
func (s *PendingL2Store) Load(taskID string) (*PendingL2State, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st, ok := s.states[taskID]
	return st, ok
}

// ListAll returns all pending L2 states.
// Used on daemon restart to notify ClawLess of tasks still awaiting authorization.
func (s *PendingL2Store) ListAll() []*PendingL2State {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]*PendingL2State, 0, len(s.states))
	for _, st := range s.states {
		result = append(result, st)
	}
	return result
}

// Count returns the number of pending L2 states.
func (s *PendingL2Store) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.states)
}

// Restore loads all pending L2 states from disk on daemon startup.
func (s *PendingL2Store) Restore() error {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read pending_l2 dir: %w", err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		path := filepath.Join(s.dir, entry.Name())
		raw, err := os.ReadFile(path)
		if err != nil {
			slog.Warn("failed to read pending_l2 state", "path", path, "error", err)
			continue
		}
		var st PendingL2State
		if err := json.Unmarshal(raw, &st); err != nil {
			slog.Warn("failed to parse pending_l2 state", "path", path, "error", err)
			continue
		}
		s.states[st.TaskID] = &st
	}

	if len(s.states) > 0 {
		slog.Info("pending_l2 store restored", "count", len(s.states))
	}
	return nil
}

func (s *PendingL2Store) statePath(taskID string) string {
	return filepath.Join(s.dir, taskID+".json")
}

func (s *PendingL2Store) writeToDisk(state *PendingL2State) error {
	path := s.statePath(state.TaskID)
	raw, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("marshal pending_l2 state: %w", err)
	}
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, raw, 0o640); err != nil {
		return fmt.Errorf("write pending_l2 state: %w", err)
	}
	return os.Rename(tmpPath, path)
}
