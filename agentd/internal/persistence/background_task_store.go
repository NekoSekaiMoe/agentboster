package persistence

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/clawless/agentd/internal/sandbox"
)

// BackgroundTask represents a background command execution.
type BackgroundTask struct {
	ID          string    `json:"id"`
	TaskID      string    `json:"task_id"`       // ClawLess task ID
	SessionID   string    `json:"session_id"`
	SandboxID   string    `json:"sandbox_id"`
	Command     string    `json:"command"`
	PID         int       `json:"pid"`
	LogPath     string    `json:"log_path"`      // Path inside sandbox
	Status      string    `json:"status"`        // running|completed|failed|orphaned
	StartedAt   time.Time `json:"started_at"`
	LastOutput  string    `json:"last_output"`   // Truncated to 4KB
	OutputBytes int64     `json:"output_bytes"`  // Total bytes of output so far
	ExitCode    *int      `json:"exit_code,omitempty"`
	CompletedAt time.Time `json:"completed_at,omitempty"`
}

// BackgroundTaskStore persists background task state to disk.
type BackgroundTaskStore struct {
	mu    sync.RWMutex
	tasks map[string]*BackgroundTask // key = bg task ID
	dir   string
}

// NewBackgroundTaskStore creates a background task store.
func NewBackgroundTaskStore(dir string) (*BackgroundTaskStore, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("create background_tasks dir: %w", err)
	}
	s := &BackgroundTaskStore{
		tasks: make(map[string]*BackgroundTask),
		dir:   dir,
	}
	return s, nil
}

// BackgroundTaskPath returns the default path for background task storage.
func BackgroundTaskPath(base string) string {
	return filepath.Join(base, "background_tasks")
}

// Save persists a background task to memory and disk.
func (s *BackgroundTaskStore) Save(bt *BackgroundTask) error {
	s.mu.Lock()
	s.tasks[bt.ID] = bt
	s.mu.Unlock()
	return s.writeToDisk(bt)
}

// Load returns a background task by its ID.
func (s *BackgroundTaskStore) Load(id string) (*BackgroundTask, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	bt, ok := s.tasks[id]
	return bt, ok
}

// LoadByTaskID finds background tasks by ClawLess task ID.
func (s *BackgroundTaskStore) LoadByTaskID(taskID string) []*BackgroundTask {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var result []*BackgroundTask
	for _, bt := range s.tasks {
		if bt.TaskID == taskID {
			result = append(result, bt)
		}
	}
	return result
}

// ListRunning returns all running background tasks.
// Used on daemon restart to resume tracking.
func (s *BackgroundTaskStore) ListRunning() []*BackgroundTask {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var result []*BackgroundTask
	for _, bt := range s.tasks {
		if bt.Status == "running" {
			result = append(result, bt)
		}
	}
	return result
}

// ListAll returns all background tasks.
func (s *BackgroundTaskStore) ListAll() []*BackgroundTask {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]*BackgroundTask, 0, len(s.tasks))
	for _, bt := range s.tasks {
		result = append(result, bt)
	}
	return result
}

// ScanOrphans checks running tasks and marks orphaned ones.
// A task is orphaned if its PID is no longer alive in the sandbox.
// Returns the list of orphaned tasks.
func (s *BackgroundTaskStore) ScanOrphans(sbMgr *sandbox.Manager) []*BackgroundTask {
	s.mu.Lock()
	defer s.mu.Unlock()

	var orphaned []*BackgroundTask
	for _, bt := range s.tasks {
		if bt.Status != "running" {
			continue
		}
		alive := s.isProcessAlive(sbMgr, bt.SandboxID, bt.PID)
		if !alive {
			bt.Status = "orphaned"
			bt.CompletedAt = time.Now()
			orphaned = append(orphaned, bt)
			if err := s.writeToDisk(bt); err != nil {
				slog.Warn("failed to persist orphaned task", "id", bt.ID, "error", err)
			}
		}
	}

	if len(orphaned) > 0 {
		slog.Info("background tasks scanned for orphans", "orphaned", len(orphaned))
	}
	return orphaned
}

// Remove deletes a background task from memory and disk.
func (s *BackgroundTaskStore) Remove(id string) error {
	s.mu.Lock()
	delete(s.tasks, id)
	s.mu.Unlock()
	return os.Remove(s.taskPath(id))
}

// Restore loads all background tasks from disk on daemon startup.
func (s *BackgroundTaskStore) Restore() error {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read background_tasks dir: %w", err)
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
			slog.Warn("failed to read background task", "path", path, "error", err)
			continue
		}
		var bt BackgroundTask
		if err := json.Unmarshal(raw, &bt); err != nil {
			slog.Warn("failed to parse background task", "path", path, "error", err)
			continue
		}
		s.tasks[bt.ID] = &bt
	}

	if len(s.tasks) > 0 {
		slog.Info("background task store restored", "count", len(s.tasks), "running", len(s.ListRunningUnsafe()))
	}
	return nil
}

// ListRunningUnsafe returns running tasks without lock (caller must hold lock).
func (s *BackgroundTaskStore) ListRunningUnsafe() []*BackgroundTask {
	var result []*BackgroundTask
	for _, bt := range s.tasks {
		if bt.Status == "running" {
			result = append(result, bt)
		}
	}
	return result
}

func (s *BackgroundTaskStore) taskPath(id string) string {
	return filepath.Join(s.dir, id+".json")
}

func (s *BackgroundTaskStore) writeToDisk(bt *BackgroundTask) error {
	path := s.taskPath(bt.ID)
	raw, err := json.Marshal(bt)
	if err != nil {
		return fmt.Errorf("marshal background task: %w", err)
	}
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, raw, 0o640); err != nil {
		return fmt.Errorf("write background task: %w", err)
	}
	return os.Rename(tmpPath, path)
}

func (s *BackgroundTaskStore) isProcessAlive(sbMgr *sandbox.Manager, sandboxID string, pid int) bool {
	if sandboxID == "" || pid <= 0 {
		return false
	}
	// Check if PID is alive by running `kill -0 <pid>` in the sandbox
	result, err := sbMgr.Exec(sandboxID, fmt.Sprintf("kill -0 %d 2>/dev/null; echo $?", pid), nil, 5)
	if err != nil {
		return false
	}
	return result.Stdout == "0\n" || result.Stdout == "0"
}
