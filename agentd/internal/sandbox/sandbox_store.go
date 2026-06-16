//go:build linux
// +build linux

package sandbox

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// SandboxRecord is the serializable form of a Sandbox, used for crash-recovery
// persistence. It omits any non-serializable fields (the in-memory Sandbox has
// none today, but we keep the type separate so future mutex/chan fields on
// Sandbox do not silently break JSON marshalling).
type SandboxRecord struct {
	ID         string    `json:"id"`
	Type       string    `json:"type"`
	Path       string    `json:"path"`
	Status     string    `json:"status"`
	Persistent bool      `json:"persistent"`
	CreatedAt  time.Time `json:"created_at"`
}

func recordFromSandbox(sb *Sandbox) *SandboxRecord {
	if sb == nil {
		return nil
	}
	return &SandboxRecord{
		ID:         sb.ID,
		Type:       sb.Type,
		Path:       sb.Path,
		Status:     sb.Status,
		Persistent: sb.Persistent,
		CreatedAt:  sb.CreatedAt,
	}
}

func sandboxFromRecord(r *SandboxRecord) *Sandbox {
	if r == nil {
		return nil
	}
	return &Sandbox{
		ID:         r.ID,
		Type:       r.Type,
		Path:       r.Path,
		Status:     r.Status,
		Persistent: r.Persistent,
		CreatedAt:  r.CreatedAt,
	}
}

// SandboxStore persists Sandbox records to disk so that sandbox IDs survive
// daemon restarts. Without it, the in-memory map is lost on every restart
// and any non-self-cleaning containers (docker-strict, LXC) leak.
//
// The store is a directory of JSON files keyed by sandbox ID. It uses the
// same atomic write-then-rename pattern as persistence/kvstore.go.
type SandboxStore struct {
	mu   sync.Mutex
	dir  string
	disk map[string]*SandboxRecord // mirror of on-disk state, kept for fast List()
}

// NewSandboxStore creates a new store rooted at dir. The directory is created
// if missing. An empty dir disables persistence (store becomes a no-op).
func NewSandboxStore(dir string) (*SandboxStore, error) {
	s := &SandboxStore{
		disk: make(map[string]*SandboxRecord),
	}
	if dir == "" {
		return s, nil
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("create sandbox store dir: %w", err)
	}
	s.dir = dir
	if err := s.loadFromDisk(); err != nil {
		slog.Warn("sandbox store: partial load failure", "error", err)
	}
	return s, nil
}

// Save writes a record to memory and disk.
func (s *SandboxStore) Save(sb *Sandbox) error {
	if s == nil || sb == nil {
		return nil
	}
	rec := recordFromSandbox(sb)
	s.mu.Lock()
	s.disk[rec.ID] = rec
	err := s.writeToDiskLocked(rec)
	s.mu.Unlock()
	return err
}

// Remove deletes a record by sandbox ID.
func (s *SandboxStore) Remove(id string) error {
	if s == nil || id == "" {
		return nil
	}
	s.mu.Lock()
	delete(s.disk, id)
	err := s.removeFromDiskLocked(id)
	s.mu.Unlock()
	return err
}

// List returns a snapshot of all persisted records.
func (s *SandboxStore) List() []*SandboxRecord {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*SandboxRecord, 0, len(s.disk))
	for _, r := range s.disk {
		out = append(out, r)
	}
	return out
}

// Has reports whether a record exists for the given ID.
func (s *SandboxStore) Has(id string) bool {
	if s == nil || id == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.disk[id]
	return ok
}

func (s *SandboxStore) loadFromDisk() error {
	if s.dir == "" {
		return nil
	}
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		path := filepath.Join(s.dir, entry.Name())
		raw, err := os.ReadFile(path)
		if err != nil {
			slog.Warn("sandbox store: read failed", "path", path, "error", err)
			continue
		}
		var rec SandboxRecord
		if err := jsonUnmarshalQuiet(raw, &rec); err != nil {
			slog.Warn("sandbox store: parse failed", "path", path, "error", err)
			continue
		}
		s.disk[rec.ID] = &rec
	}
	if len(s.disk) > 0 {
		slog.Info("sandbox store loaded", "count", len(s.disk), "dir", s.dir)
	}
	return nil
}

func (s *SandboxStore) writeToDiskLocked(rec *SandboxRecord) error {
	if s.dir == "" {
		return nil
	}
	path := s.recordPath(rec.ID)
	raw, err := jsonMarshalQuiet(rec)
	if err != nil {
		return fmt.Errorf("marshal sandbox record: %w", err)
	}
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, raw, 0o640); err != nil {
		return fmt.Errorf("write sandbox record: %w", err)
	}
	return os.Rename(tmpPath, path)
}

func (s *SandboxStore) removeFromDiskLocked(id string) error {
	if s.dir == "" {
		return nil
	}
	path := s.recordPath(id)
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (s *SandboxStore) recordPath(id string) string {
	return filepath.Join(s.dir, id+".json")
}
