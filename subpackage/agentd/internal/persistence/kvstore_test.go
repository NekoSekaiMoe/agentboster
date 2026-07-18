package persistence

import (
	"os"
	"path/filepath"
	"testing"
)

// testItem is a minimal payload type for KeyValueStore tests.
type testItem struct {
	Key   string `json:"key"`
	Value string `json:"value"`
	N     int    `json:"n"`
}

func itemKey(it *testItem) string { return it.Key }

func newTestStore(t *testing.T, dir string) *KeyValueStore[testItem] {
	t.Helper()
	s, err := NewKeyValueStore[testItem](dir, "test", itemKey)
	if err != nil {
		t.Fatalf("NewKeyValueStore: %v", err)
	}
	return s
}

func TestKeyValueStore_SaveLoadRoundTrip(t *testing.T) {
	s := newTestStore(t, "")
	if err := s.Save(&testItem{Key: "k1", Value: "v1", N: 42}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, ok := s.Load("k1")
	if !ok {
		t.Fatal("Load after Save: not found")
	}
	if got.Value != "v1" || got.N != 42 {
		t.Errorf("Load = %+v, want {v1 42}", got)
	}
}

func TestKeyValueStore_LoadMiss(t *testing.T) {
	s := newTestStore(t, "")
	if _, ok := s.Load("nonexistent"); ok {
		t.Error("expected miss on empty store")
	}
}

func TestKeyValueStore_SaveOverwrites(t *testing.T) {
	s := newTestStore(t, "")
	_ = s.Save(&testItem{Key: "k", Value: "old"})
	_ = s.Save(&testItem{Key: "k", Value: "new"})
	got, _ := s.Load("k")
	if got.Value != "new" {
		t.Errorf("after overwrite, Value = %q, want new", got.Value)
	}
}

func TestKeyValueStore_Remove(t *testing.T) {
	s := newTestStore(t, "")
	_ = s.Save(&testItem{Key: "k", Value: "v"})
	if err := s.Remove("k"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, ok := s.Load("k"); ok {
		t.Error("Load after Remove: still present")
	}
	// Removing a non-existent key should not error.
	if err := s.Remove("never-saved"); err != nil {
		t.Errorf("Remove on missing key returned err: %v", err)
	}
}

func TestKeyValueStore_Count(t *testing.T) {
	s := newTestStore(t, "")
	for i := 0; i < 5; i++ {
		_ = s.Save(&testItem{Key: "k" + string(rune('a'+i)), Value: "v"})
	}
	// Overwrite one — count should stay the same.
	_ = s.Save(&testItem{Key: "ka", Value: "updated"})
	if got := s.Count(); got != 5 {
		t.Errorf("Count = %d, want 5", got)
	}
}

func TestKeyValueStore_ListAllReturnsEveryItem(t *testing.T) {
	s := newTestStore(t, "")
	for _, k := range []string{"a", "b", "c"} {
		_ = s.Save(&testItem{Key: k, Value: "v-" + k})
	}
	all := s.ListAll()
	if len(all) != 3 {
		t.Fatalf("ListAll = %d items, want 3", len(all))
	}
	seen := map[string]bool{}
	for _, it := range all {
		seen[it.Key] = true
		if it.Value != "v-"+it.Key {
			t.Errorf("item %q Value = %q, want %q", it.Key, it.Value, "v-"+it.Key)
		}
	}
	for _, k := range []string{"a", "b", "c"} {
		if !seen[k] {
			t.Errorf("ListAll missing key %q", k)
		}
	}
}

func TestKeyValueStore_ListWhereFiltersByPredicate(t *testing.T) {
	s := newTestStore(t, "")
	_ = s.Save(&testItem{Key: "keep", N: 1})
	_ = s.Save(&testItem{Key: "drop", N: 0})
	_ = s.Save(&testItem{Key: "keep2", N: 1})

	got := s.ListWhere(func(it *testItem) bool { return it.N == 1 })
	if len(got) != 2 {
		t.Fatalf("ListWhere = %d items, want 2", len(got))
	}
	for _, it := range got {
		if it.N != 1 {
			t.Errorf("predicate violated: item %+v has N != 1", it)
		}
	}
}

func TestKeyValueStore_DiskPersistsAcrossInstances(t *testing.T) {
	dir := t.TempDir()
	s1 := newTestStore(t, dir)
	_ = s1.Save(&testItem{Key: "persist", Value: "v"})

	// Confirm file landed on disk.
	matches, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil || len(matches) == 0 {
		t.Fatalf("expected file under %s, matches=%v err=%v", dir, matches, err)
	}

	// New store instance pointing at the same dir should pick up the
	// persisted item via Restore.
	s2 := newTestStore(t, dir)
	if err := s2.Restore(); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	got, ok := s2.Load("persist")
	if !ok {
		t.Fatal("Restore did not load 'persist' item")
	}
	if got.Value != "v" {
		t.Errorf("restored Value = %q, want v", got.Value)
	}
}

func TestKeyValueStore_RestoreNoopWithoutDir(t *testing.T) {
	// Empty dir means in-memory only — Restore should be a no-op and
	// return nil. Otherwise a default Restore() call on startup could
	// surprise callers with a misleading error.
	s := newTestStore(t, "")
	if err := s.Restore(); err != nil {
		t.Errorf("Restore with empty dir = %v, want nil", err)
	}
}

func TestKeyValueStore_DiskRemoveDeletesFile(t *testing.T) {
	dir := t.TempDir()
	s := newTestStore(t, dir)
	_ = s.Save(&testItem{Key: "kill", Value: "v"})
	path := filepath.Join(dir, "kill.json")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected file at %s: %v", path, err)
	}
	if err := s.Remove("kill"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("expected file removed, stat err = %v", err)
	}
}

func TestKeyValueStore_RestoreSkipsNonJsonAndCorrupt(t *testing.T) {
	dir := t.TempDir()
	s := newTestStore(t, dir)
	_ = s.Save(&testItem{Key: "good", Value: "v"})

	// Drop a non-JSON file in the dir — Restore should ignore it.
	if err := os.WriteFile(filepath.Join(dir, "readme.txt"), []byte("ignore me"), 0o640); err != nil {
		t.Fatal(err)
	}
	// Drop a malformed .json file — Restore should skip it.
	if err := os.WriteFile(filepath.Join(dir, "broken.json"), []byte("{not json"), 0o640); err != nil {
		t.Fatal(err)
	}

	s2 := newTestStore(t, dir)
	if err := s2.Restore(); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if got := s2.Count(); got != 1 {
		t.Errorf("Count = %d, want 1 (only 'good')", got)
	}
	if _, ok := s2.Load("good"); !ok {
		t.Error("expected 'good' to be loaded")
	}
}

// BackgroundTaskStore is a thin wrapper around KeyValueStore — verify
// the wrapper-specific helpers (LoadByTaskID, ListRunning) compile and
// return correctly filtered results without dragging in sandbox.Manager
// (which ScanOrphans needs and is integration-test territory).
func TestBackgroundTaskStore_FiltersAndPersists(t *testing.T) {
	dir := t.TempDir()
	store, err := NewBackgroundTaskStore(dir)
	if err != nil {
		t.Fatalf("NewBackgroundTaskStore: %v", err)
	}

	t1 := &BackgroundTask{ID: "t1", TaskID: "job-A", Status: "running"}
	t2 := &BackgroundTask{ID: "t2", TaskID: "job-A", Status: "completed"}
	t3 := &BackgroundTask{ID: "t3", TaskID: "job-B", Status: "running"}
	for _, bt := range []*BackgroundTask{t1, t2, t3} {
		if err := store.Save(bt); err != nil {
			t.Fatalf("Save %s: %v", bt.ID, err)
		}
	}

	// LoadByTaskID returns all entries with matching TaskID regardless
	// of status.
	gotA := store.LoadByTaskID("job-A")
	if len(gotA) != 2 {
		t.Errorf("LoadByTaskID(job-A) = %d items, want 2", len(gotA))
	}

	// ListRunning filters by status == "running".
	running := store.ListRunning()
	if len(running) != 2 {
		t.Errorf("ListRunning = %d items, want 2", len(running))
	}
	for _, bt := range running {
		if bt.Status != "running" {
			t.Errorf("ListRunning returned non-running entry %+v", bt)
		}
	}

	// Count and Remove pass through.
	if got := len(store.ListAll()); got != 3 {
		t.Errorf("ListAll = %d items, want 3", got)
	}
	if err := store.Remove("t2"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if got := len(store.ListAll()); got != 2 {
		t.Errorf("after Remove, ListAll = %d, want 2", got)
	}

	// Persistence survives a fresh store instance via Restore.
	store2, err := NewBackgroundTaskStore(dir)
	if err != nil {
		t.Fatalf("recreate store: %v", err)
	}
	if err := store2.Restore(); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	// 2 items remaining on disk (t2 was removed).
	if got := len(store2.ListAll()); got != 2 {
		t.Errorf("after Restore, ListAll = %d, want 2", got)
	}
}

func TestBackgroundTaskPath(t *testing.T) {
	if got, want := BackgroundTaskPath("/var/lib/agentd"), "/var/lib/agentd/background_tasks"; got != want {
		t.Errorf("BackgroundTaskPath = %q, want %q", got, want)
	}
}
