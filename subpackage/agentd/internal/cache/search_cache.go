//go:build linux

package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// SearchCacheEntry holds a cached search result.
type SearchCacheEntry struct {
	Query     string    `json:"query"`
	Results   string    `json:"results"`
	CachedAt  time.Time `json:"cached_at"`
	ExpiresAt time.Time `json:"expires_at"`
	Source    string    `json:"source"`
}

// SearchCache provides a simple query→result cache for web searches.
type SearchCache struct {
	mu      sync.RWMutex
	entries map[string]*SearchCacheEntry
	dir     string
	ttl     time.Duration
}

// NewSearchCache creates a search cache backed by the given directory.
func NewSearchCache(dir string, ttl time.Duration) *SearchCache {
	if ttl <= 0 {
		ttl = 30 * time.Minute
	}
	c := &SearchCache{
		entries: make(map[string]*SearchCacheEntry),
		dir:     dir,
		ttl:     ttl,
	}
	c.loadFromDisk()
	return c
}

func queryKey(query, source string) string {
	h := sha256.Sum256([]byte(source + ":" + query))
	return hex.EncodeToString(h[:16])
}

// Get returns a cached result if still valid, or nil.
func (c *SearchCache) Get(query, source string) *SearchCacheEntry {
	key := queryKey(query, source)
	c.mu.RLock()
	entry, ok := c.entries[key]
	c.mu.RUnlock()

	if !ok || time.Now().After(entry.ExpiresAt) {
		return nil
	}
	return entry
}

// Put stores a search result.
func (c *SearchCache) Put(query, source, results string) {
	key := queryKey(query, source)
	now := time.Now()
	entry := &SearchCacheEntry{
		Query:     query,
		Results:   results,
		CachedAt:  now,
		ExpiresAt: now.Add(c.ttl),
		Source:    source,
	}

	c.mu.Lock()
	c.entries[key] = entry
	c.mu.Unlock()

	c.saveToDisk(key, entry)
}

// History returns a list of recent unique queries.
func (c *SearchCache) History(limit int) []string {
	c.mu.RLock()
	defer c.mu.RUnlock()

	type timestamped struct {
		query string
		at    time.Time
	}
	var items []timestamped
	seen := make(map[string]bool)
	for _, entry := range c.entries {
		if seen[entry.Query] {
			continue
		}
		seen[entry.Query] = true
		items = append(items, timestamped{query: entry.Query, at: entry.CachedAt})
	}

	// Sort newest first
	for i := 0; i < len(items); i++ {
		for j := i + 1; j < len(items); j++ {
			if items[j].at.After(items[i].at) {
				items[i], items[j] = items[j], items[i]
			}
		}
	}

	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}

	queries := make([]string, len(items))
	for i, item := range items {
		queries[i] = item.query
	}
	return queries
}

// Prune removes expired entries.
func (c *SearchCache) Prune() int {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	pruned := 0
	for key, entry := range c.entries {
		if now.After(entry.ExpiresAt) {
			delete(c.entries, key)
			if c.dir != "" {
				os.Remove(filepath.Join(c.dir, key+".json"))
			}
			pruned++
		}
	}
	return pruned
}

func (c *SearchCache) saveToDisk(key string, entry *SearchCacheEntry) {
	if c.dir == "" {
		return
	}
	os.MkdirAll(c.dir, 0o755)
	data, err := json.Marshal(entry)
	if err != nil {
		return
	}
	os.WriteFile(filepath.Join(c.dir, key+".json"), data, 0o640)
}

func (c *SearchCache) loadFromDisk() {
	if c.dir == "" {
		return
	}
	entries, err := os.ReadDir(c.dir)
	if err != nil {
		return
	}

	now := time.Now()
	for _, e := range entries {
		if !e.Type().IsRegular() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(c.dir, e.Name()))
		if err != nil {
			continue
		}
		var entry SearchCacheEntry
		if err := json.Unmarshal(data, &entry); err != nil {
			continue
		}
		if now.After(entry.ExpiresAt) {
			continue
		}
		key := e.Name()[:len(e.Name())-5]
		c.entries[key] = &entry
	}

	slog.Info("search cache loaded", "entries", len(c.entries))
}
