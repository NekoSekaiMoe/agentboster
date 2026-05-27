package persistence

import (
	"path/filepath"
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
type PendingL2Store struct {
	kv *KeyValueStore[PendingL2State]
}

func NewPendingL2Store(dir string) (*PendingL2Store, error) {
	kv, err := NewKeyValueStore(dir, "pending_l2", func(s *PendingL2State) string {
		return s.TaskID
	})
	if err != nil {
		return nil, err
	}
	return &PendingL2Store{kv: kv}, nil
}

func PendingL2Path(base string) string {
	return filepath.Join(base, "pending_l2")
}

func (s *PendingL2Store) Save(state *PendingL2State) error {
	return s.kv.Save(state)
}

func (s *PendingL2Store) Load(taskID string) (*PendingL2State, bool) {
	return s.kv.Load(taskID)
}

func (s *PendingL2Store) Remove(taskID string) error {
	return s.kv.Remove(taskID)
}

func (s *PendingL2Store) ListAll() []*PendingL2State {
	return s.kv.ListAll()
}

func (s *PendingL2Store) Count() int {
	return s.kv.Count()
}

func (s *PendingL2Store) Restore() error {
	return s.kv.Restore()
}
