package persistence

import (
	"fmt"
	"path/filepath"
	"time"

	"github.com/clawless/agentd/internal/sandbox"
)

// BackgroundTask represents a background command execution.
type BackgroundTask struct {
	ID          string    `json:"id"`
	TaskID      string    `json:"task_id"`
	SessionID   string    `json:"session_id"`
	SandboxID   string    `json:"sandbox_id"`
	Command     string    `json:"command"`
	PID         int       `json:"pid"`
	LogPath     string    `json:"log_path"`
	Status      string    `json:"status"`
	StartedAt   time.Time `json:"started_at"`
	LastOutput  string    `json:"last_output"`
	OutputBytes int64     `json:"output_bytes"`
	ExitCode    *int      `json:"exit_code,omitempty"`
	CompletedAt time.Time `json:"completed_at,omitempty"`
}

// BackgroundTaskStore persists background task state to disk.
type BackgroundTaskStore struct {
	kv *KeyValueStore[BackgroundTask]
}

func NewBackgroundTaskStore(dir string) (*BackgroundTaskStore, error) {
	kv, err := NewKeyValueStore(dir, "background_tasks", func(bt *BackgroundTask) string {
		return bt.ID
	})
	if err != nil {
		return nil, err
	}
	return &BackgroundTaskStore{kv: kv}, nil
}

func BackgroundTaskPath(base string) string {
	return filepath.Join(base, "background_tasks")
}

func (s *BackgroundTaskStore) Save(bt *BackgroundTask) error {
	return s.kv.Save(bt)
}

func (s *BackgroundTaskStore) Load(id string) (*BackgroundTask, bool) {
	return s.kv.Load(id)
}

func (s *BackgroundTaskStore) LoadByTaskID(taskID string) []*BackgroundTask {
	return s.kv.ListWhere(func(bt *BackgroundTask) bool {
		return bt.TaskID == taskID
	})
}

func (s *BackgroundTaskStore) ListRunning() []*BackgroundTask {
	return s.kv.ListWhere(func(bt *BackgroundTask) bool {
		return bt.Status == "running"
	})
}

func (s *BackgroundTaskStore) ListAll() []*BackgroundTask {
	return s.kv.ListAll()
}

func (s *BackgroundTaskStore) Remove(id string) error {
	return s.kv.Remove(id)
}

func (s *BackgroundTaskStore) Restore() error {
	return s.kv.Restore()
}

func (s *BackgroundTaskStore) ScanOrphans(sbMgr *sandbox.Manager) []*BackgroundTask {
	var orphaned []*BackgroundTask
	for _, bt := range s.ListRunning() {
		if !isProcessAlive(sbMgr, bt.SandboxID, bt.PID) {
			bt.Status = "orphaned"
			bt.CompletedAt = time.Now()
			if err := s.Save(bt); err != nil {
				fmt.Printf("warn: failed to persist orphaned task %s: %v\n", bt.ID, err)
			}
			orphaned = append(orphaned, bt)
		}
	}
	return orphaned
}

func isProcessAlive(sbMgr *sandbox.Manager, sandboxID string, pid int) bool {
	if sandboxID == "" || pid <= 0 {
		return false
	}
	result, err := sbMgr.Exec(sandboxID, fmt.Sprintf("kill -0 %d 2>/dev/null; echo $?", pid), nil, 5)
	if err != nil {
		return false
	}
	return result.Stdout == "0\n" || result.Stdout == "0"
}
