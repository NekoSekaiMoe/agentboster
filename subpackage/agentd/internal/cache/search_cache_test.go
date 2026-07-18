//go:build linux

package cache

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSearchCache_PutGet(t *testing.T) {
	c := NewSearchCache("", 10*time.Minute)

	c.Put("hello world", "google", "result-1")
	got := c.Get("hello world", "google")
	if got == nil {
		t.Fatal("expected entry after Put, got nil")
	}
	if got.Results != "result-1" {
		t.Fatalf("Results = %q, want %q", got.Results, "result-1")
	}
	if got.Query != "hello world" {
		t.Fatalf("Query = %q, want %q", got.Query, "hello world")
	}
	if got.Source != "google" {
		t.Fatalf("Source = %q, want %q", got.Source, "google")
	}
	if got.CachedAt.IsZero() {
		t.Fatal("CachedAt should be set")
	}
	if got.ExpiresAt.IsZero() {
		t.Fatal("ExpiresAt should be set")
	}
	if !got.ExpiresAt.After(got.CachedAt) {
		t.Fatal("ExpiresAt must be strictly after CachedAt")
	}
}

func TestSearchCache_GetMiss(t *testing.T) {
	c := NewSearchCache("", 10*time.Minute)
	if got := c.Get("nonexistent", "google"); got != nil {
		t.Fatalf("expected nil for cache miss, got %+v", got)
	}
}

func TestSearchCache_KeyIsolationBySource(t *testing.T) {
	c := NewSearchCache("", 10*time.Minute)

	c.Put("same query", "google", "g-result")
	c.Put("same query", "bing", "b-result")

	gotG := c.Get("same query", "google")
	gotB := c.Get("same query", "bing")
	if gotG == nil || gotB == nil {
		t.Fatal("expected both entries to be present")
	}
	if gotG.Results == gotB.Results {
		t.Fatalf("entries collapsed: both returned %q", gotG.Results)
	}
	if gotG.Results != "g-result" {
		t.Fatalf("google result = %q, want g-result", gotG.Results)
	}
	if gotB.Results != "b-result" {
		t.Fatalf("bing result = %q, want b-result", gotB.Results)
	}
}

func TestSearchCache_OverwriteOnSameKey(t *testing.T) {
	c := NewSearchCache("", 10*time.Minute)

	c.Put("q", "src", "old")
	c.Put("q", "src", "new")

	got := c.Get("q", "src")
	if got == nil {
		t.Fatal("expected entry after overwrite")
	}
	if got.Results != "new" {
		t.Fatalf("Results = %q, want %q (latest Put should win)", got.Results, "new")
	}
}

func TestSearchCache_ExpiredReturnsNil(t *testing.T) {
	// NewSearchCache substitutes 30m for any ttl <= 0, so we can't
	// construct an already-expired cache via the constructor. Instead
	// insert a live entry, then mutate its ExpiresAt into the past
	// directly and confirm Get treats it as expired.
	c := NewSearchCache("", 10*time.Minute)
	c.Put("expired", "src", "result")
	for _, v := range c.entries {
		v.ExpiresAt = time.Now().Add(-time.Hour)
	}
	if got := c.Get("expired", "src"); got != nil {
		t.Fatalf("expected nil for expired entry, got %+v", got)
	}
}

func TestSearchCache_DefaultTTLWhenZeroOrNegative(t *testing.T) {
	// NewSearchCache substitutes 30m when ttl <= 0. Verify the entry
	// actually lives ~30 minutes, not the literal value passed in.
	c := NewSearchCache("", 0)
	c.Put("q", "src", "r")
	got := c.Get("q", "src")
	if got == nil {
		t.Fatal("expected entry even with ttl=0 (default applied)")
	}
	want := got.CachedAt.Add(30 * time.Minute)
	delta := got.ExpiresAt.Sub(want)
	if delta > time.Second || delta < -time.Second {
		t.Fatalf("ExpiresAt = %v, want ~%v (30m default)", got.ExpiresAt, want)
	}
}

func TestSearchCache_HistoryOrdersByNewestFirst(t *testing.T) {
	c := NewSearchCache("", 10*time.Minute)

	// Insert in non-sorted order with distinct timestamps. Put uses
	// time.Now() so we sleep briefly between calls to guarantee
	// ordering.
	c.Put("oldest", "src", "r1")
	time.Sleep(2 * time.Millisecond)
	c.Put("middle", "src", "r2")
	time.Sleep(2 * time.Millisecond)
	c.Put("newest", "src", "r3")

	history := c.History(0)
	if len(history) != 3 {
		t.Fatalf("len(history) = %d, want 3", len(history))
	}
	if history[0] != "newest" {
		t.Errorf("history[0] = %q, want %q", history[0], "newest")
	}
	if history[1] != "middle" {
		t.Errorf("history[1] = %q, want %q", history[1], "middle")
	}
	if history[2] != "oldest" {
		t.Errorf("history[2] = %q, want %q", history[2], "oldest")
	}
}

func TestSearchCache_HistoryDedupesByQuery(t *testing.T) {
	// Same query, different sources — should appear once in history
	// (deduped by Query field, not by key).
	c := NewSearchCache("", 10*time.Minute)
	c.Put("duplicate", "google", "r1")
	c.Put("duplicate", "bing", "r2")

	history := c.History(0)
	if len(history) != 1 {
		t.Fatalf("len(history) = %d, want 1 (dedup by query)", len(history))
	}
	if history[0] != "duplicate" {
		t.Errorf("history[0] = %q, want %q", history[0], "duplicate")
	}
}

func TestSearchCache_HistoryLimit(t *testing.T) {
	c := NewSearchCache("", 10*time.Minute)
	for i, q := range []string{"a", "b", "c", "d", "e"} {
		c.Put(q, "src", "r")
		time.Sleep(time.Millisecond)
		_ = i
	}

	if got := c.History(3); len(got) != 3 {
		t.Fatalf("len(History(3)) = %d, want 3", len(got))
	}
	// Newest-first: limit=3 keeps the three most recent queries.
	want := []string{"e", "d", "c"}
	for i, q := range c.History(3) {
		if q != want[i] {
			t.Errorf("History(3)[%d] = %q, want %q", i, q, want[i])
		}
	}
}

func TestSearchCache_PruneRemovesExpired(t *testing.T) {
	c := NewSearchCache("", 10*time.Minute)
	c.Put("fresh", "src", "r1")

	// NewSearchCache forces ttl > 0 (defaults to 30m), so inject an
	// expired entry by mutating ExpiresAt after Put.
	c.Put("will-expire", "src", "r2")
	for _, v := range c.entries {
		if v.Query == "will-expire" {
			v.ExpiresAt = time.Now().Add(-time.Hour)
		}
	}

	pruned := c.Prune()
	if pruned != 1 {
		t.Fatalf("Prune() = %d, want 1", pruned)
	}
	if got := c.Get("fresh", "src"); got == nil {
		t.Error("Prune should keep fresh entries, but fresh is missing")
	}
	// Re-Get on expired returns nil anyway (Get checks ExpiresAt), so
	// the real assertion is that Prune returned 1 (the expired entry
	// was actively removed from the map).
}

func TestSearchCache_DiskRoundTrip(t *testing.T) {
	dir := t.TempDir()
	c1 := NewSearchCache(dir, 10*time.Minute)
	c1.Put("persisted", "src", "result-on-disk")

	// Confirm the entry landed on disk so we're not testing the empty
	// dir happy-path.
	matches, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	if len(matches) == 0 {
		t.Fatalf("expected at least one cache file under %s, found none", dir)
	}

	// New cache pointing at the same dir should load the entry back.
	c2 := NewSearchCache(dir, 10*time.Minute)
	got := c2.Get("persisted", "src")
	if got == nil {
		t.Fatal("expected entry to be reloaded from disk, got nil")
	}
	if got.Results != "result-on-disk" {
		t.Fatalf("reloaded Results = %q, want result-on-disk", got.Results)
	}
}

func TestSearchCache_PruneRemovesDiskFile(t *testing.T) {
	dir := t.TempDir()
	c := NewSearchCache(dir, 10*time.Minute)
	c.Put("will-expire", "src", "r")

	// Verify file exists before prune.
	matches, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil || len(matches) == 0 {
		t.Fatalf("expected cache file to exist before prune: %v", err)
	}

	// Force expiry: mutate the in-memory entry to be already expired.
	for k, v := range c.entries {
		v.ExpiresAt = time.Now().Add(-time.Hour)
		_ = k
	}

	if pruned := c.Prune(); pruned != 1 {
		t.Fatalf("Prune() = %d, want 1", pruned)
	}

	matches, err = filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		t.Fatalf("glob after prune: %v", err)
	}
	if len(matches) != 0 {
		t.Fatalf("expected disk file removed, found %d: %v", len(matches), matches)
	}
}

func TestSearchCache_DiskSkipsExpiredOnLoad(t *testing.T) {
	dir := t.TempDir()

	// Write an entry whose ExpiresAt is already in the past.
	c1 := NewSearchCache(dir, 10*time.Minute)
	c1.Put("gone", "src", "r")
	for _, v := range c1.entries {
		v.ExpiresAt = time.Now().Add(-time.Hour)
		// Re-save with the new timestamp so disk has the expired form.
		data, _ := json.Marshal(v)
		_ = os.WriteFile(filepath.Join(dir, queryKey("gone", "src")+".json"), data, 0o640)
	}

	// Fresh load should skip the expired entry.
	c2 := NewSearchCache(dir, 10*time.Minute)
	if got := c2.Get("gone", "src"); got != nil {
		t.Fatalf("expected expired disk entry to be skipped on load, got %+v", got)
	}
}
