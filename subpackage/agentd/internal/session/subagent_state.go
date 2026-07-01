package session

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// SubagentState holds the persistent state of a sub-agent session.
// Saved to workspace/sessions/subagent_{id}.json so crashed sub-agents can resume.
type SubagentState struct {
	ID              string         `json:"id"`
	TaskID          string         `json:"task_id"`
	ParentSessionID string         `json:"parent_session_id"`
	AgentID         string         `json:"agent_id"`
	Step            int            `json:"step"`
	MaxSteps        int            `json:"maxSteps"`
	Messages        []ChatMessage  `json:"messages"`
	ToolCalls       []ToolCallRecord `json:"tool_calls"`
	KeyDecisions    []string       `json:"key_decisions"`
	SandboxID       string         `json:"sandbox_id"`
	SandboxType     string         `json:"sandbox_type"`
	SandboxPath     string         `json:"sandbox_path"`
	Status          string         `json:"status"` // running/completed/failed/crashed
	LastError       string         `json:"last_error,omitempty"`
	CreatedAt       time.Time      `json:"created_at"`
	LastSavedAt     time.Time      `json:"last_saved_at"`
}

// ChatMessage represents a single message in the sub-agent conversation.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ToolCallRecord tracks a tool invocation within the sub-agent.
type ToolCallRecord struct {
	Tool    string `json:"tool"`
	Args    string `json:"args"`
	Result  string `json:"result"`
	Success bool   `json:"success"`
}

// SubagentStateStore manages sub-agent state persistence.
type SubagentStateStore struct {
	mu      sync.RWMutex
	states  map[string]*SubagentState
	baseDir string // workspace/sessions directory
}

// NewSubagentStateStore creates a new state store.
func NewSubagentStateStore(workspaceSessionsDir string) *SubagentStateStore {
	return &SubagentStateStore{
		states:  make(map[string]*SubagentState),
		baseDir: workspaceSessionsDir,
	}
}

// Save persists a sub-agent state to disk.
func (s *SubagentStateStore) Save(state *SubagentState) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	state.LastSavedAt = time.Now()
	s.states[state.ID] = state

	path := s.statePath(state.ID)
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create sessions dir: %w", err)
	}

	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal subagent state: %w", err)
	}

	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0o640); err != nil {
		return fmt.Errorf("write subagent state: %w", err)
	}

	return os.Rename(tmpPath, path)
}

// Load retrieves a sub-agent state from disk.
func (s *SubagentStateStore) Load(id string) (*SubagentState, error) {
	s.mu.RLock()
	if state, ok := s.states[id]; ok {
		s.mu.RUnlock()
		return state, nil
	}
	s.mu.RUnlock()

	path := s.statePath(id)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read subagent state: %w", err)
	}

	var state SubagentState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("unmarshal subagent state: %w", err)
	}

	s.mu.Lock()
	s.states[id] = &state
	s.mu.Unlock()

	return &state, nil
}

// LoadAll scans the sessions directory and loads all sub-agent states.
func (s *SubagentStateStore) LoadAll() ([]*SubagentState, error) {
	entries, err := os.ReadDir(s.baseDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read sessions dir: %w", err)
	}

	var states []*SubagentState
	for _, entry := range entries {
		if entry.IsDir() || !isSubagentStateFile(entry.Name()) {
			continue
		}
		id := entry.Name()
		id = id[:len(id)-5] // remove .json
		if len(id) > 11 && id[:10] == "subagent_" {
			id = id[10:]
		}

		state, err := s.Load(id)
		if err != nil {
			continue // skip corrupted state files
		}
		states = append(states, state)
	}

	return states, nil
}

// Delete removes a sub-agent state file.
func (s *SubagentStateStore) Delete(id string) error {
	s.mu.Lock()
	delete(s.states, id)
	s.mu.Unlock()

	path := s.statePath(id)
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove subagent state: %w", err)
	}
	return nil
}

// List returns all in-memory sub-agent states.
func (s *SubagentStateStore) List() []*SubagentState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]*SubagentState, 0, len(s.states))
	for _, state := range s.states {
		result = append(result, state)
	}
	return result
}

func (s *SubagentStateStore) statePath(id string) string {
	return filepath.Join(s.baseDir, fmt.Sprintf("subagent_%s.json", id))
}

func isSubagentStateFile(name string) bool {
	return len(name) > 15 && name[:10] == "subagent_" && filepath.Ext(name) == ".json"
}
