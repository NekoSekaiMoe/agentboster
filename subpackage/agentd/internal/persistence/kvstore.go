package persistence

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
)

// KeyValueStore is a generic thread-safe key-value store with optional disk persistence.
// T must be a struct type. The keyFn extracts the string key from a *T instance.
type KeyValueStore[T any] struct {
	mu     sync.RWMutex
	items  map[string]*T
	dir    string
	keyFn  func(*T) string
	logger string // for slog context
}

// NewKeyValueStore creates a new store. If dir is non-empty, items are persisted as JSON files.
func NewKeyValueStore[T any](dir, logger string, keyFn func(*T) string) (*KeyValueStore[T], error) {
	if dir != "" {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return nil, fmt.Errorf("create %s dir: %w", logger, err)
		}
	}
	return &KeyValueStore[T]{
		items:  make(map[string]*T),
		dir:    dir,
		keyFn:  keyFn,
		logger: logger,
	}, nil
}

// Save stores an item in memory and optionally writes it to disk.
func (s *KeyValueStore[T]) Save(item *T) error {
	key := s.keyFn(item)
	s.mu.Lock()
	s.items[key] = item
	s.mu.Unlock()
	if s.dir != "" {
		return s.writeToDisk(key, item)
	}
	return nil
}

// Load returns an item by key.
func (s *KeyValueStore[T]) Load(key string) (*T, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.items[key]
	return item, ok
}

// Remove deletes an item from memory and disk.
func (s *KeyValueStore[T]) Remove(key string) error {
	s.mu.Lock()
	delete(s.items, key)
	s.mu.Unlock()
	if s.dir != "" {
		return os.Remove(s.itemPath(key))
	}
	return nil
}

// ListAll returns all items.
func (s *KeyValueStore[T]) ListAll() []*T {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]*T, 0, len(s.items))
	for _, item := range s.items {
		result = append(result, item)
	}
	return result
}

// ListWhere returns items matching a predicate.
func (s *KeyValueStore[T]) ListWhere(pred func(*T) bool) []*T {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var result []*T
	for _, item := range s.items {
		if pred(item) {
			result = append(result, item)
		}
	}
	return result
}

// Count returns the number of items.
func (s *KeyValueStore[T]) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.items)
}

// Restore loads all items from disk. Call on daemon startup.
func (s *KeyValueStore[T]) Restore() error {
	if s.dir == "" {
		return nil
	}
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read %s dir: %w", s.logger, err)
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
			slog.Warn("failed to read store item", "path", path, "error", err)
			continue
		}
		var item T
		if err := json.Unmarshal(raw, &item); err != nil {
			slog.Warn("failed to parse store item", "path", path, "error", err)
			continue
		}
		s.items[s.keyFn(&item)] = &item
	}

	if len(s.items) > 0 {
		slog.Info("store restored", "type", s.logger, "count", len(s.items))
	}
	return nil
}

func (s *KeyValueStore[T]) itemPath(key string) string {
	return filepath.Join(s.dir, key+".json")
}

func (s *KeyValueStore[T]) writeToDisk(key string, item *T) error {
	path := s.itemPath(key)
	raw, err := json.Marshal(item)
	if err != nil {
		return fmt.Errorf("marshal %s: %w", s.logger, err)
	}
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, raw, 0o640); err != nil {
		return fmt.Errorf("write %s: %w", s.logger, err)
	}
	return os.Rename(tmpPath, path)
}
