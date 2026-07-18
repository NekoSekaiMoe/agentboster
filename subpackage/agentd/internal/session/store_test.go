package session

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestValidateSessionID(t *testing.T) {
	cases := []struct {
		name    string
		id      string
		wantErr bool
	}{
		{"empty", "", true},
		{"path slash", "abc/def", true},
		{"path backslash", `abc\def`, true},
		{"path traversal", "..", true},
		{"embedded traversal", "abc/../def", true},
		{"space", "a b", true},
		{"dot", "a.b", true},
		{"letters", "abcDEF", false},
		{"digits", "0123456789", false},
		{"underscore hyphen", "abc-_DEF", false},
		{"uuid", "550e8400-e29b-41d4-a716-446655440000", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateSessionID(tc.id)
			if tc.wantErr && err == nil {
				t.Errorf("validateSessionID(%q) = nil, want error", tc.id)
			}
			if !tc.wantErr && err != nil {
				t.Errorf("validateSessionID(%q) = %v, want nil", tc.id, err)
			}
		})
	}
}

func TestStore_PutGetRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir, 100, time.Hour)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	id := "sess-123"
	data := &SessionData{
		SessionID: id,
		TaskID:    "task-1",
		AgentID:   "agent-1",
		UserID:    "user-1",
		Model:     "gpt-4",
	}
	if err := s.Put(id, data); err != nil {
		t.Fatalf("Put: %v", err)
	}

	got, ok := s.Get(id)
	if !ok {
		t.Fatal("Get after Put: not found")
	}
	if got.SessionID != id {
		t.Errorf("Get SessionID = %q, want %q", got.SessionID, id)
	}
	if got.Model != "gpt-4" {
		t.Errorf("Get Model = %q, want gpt-4", got.Model)
	}
}

func TestStore_PutRejectsInvalidID(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir, 100, time.Hour)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if err := s.Put("../escape", &SessionData{}); err == nil {
		t.Error("Put with path-traversal id should fail validation")
	}
}

func TestStore_PutPersistsToDisk(t *testing.T) {
	dir := t.TempDir()
	s1, err := NewStore(dir, 100, time.Hour)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	id := "persist-me"
	if err := s1.Put(id, &SessionData{SessionID: id, AgentID: "a1"}); err != nil {
		t.Fatalf("Put: %v", err)
	}

	// Confirm the file landed so we know the reload test below isn't
	// accidentally testing the empty-dir path.
	matches, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil || len(matches) == 0 {
		t.Fatalf("expected session file under %s, got %v (matches=%v)", dir, err, matches)
	}

	// New store pointing at the same dir should load existing sessions.
	s2, err := NewStore(dir, 100, time.Hour)
	if err != nil {
		t.Fatalf("NewStore (reload): %v", err)
	}
	got, ok := s2.Get(id)
	if !ok {
		t.Fatal("expected reloaded store to contain the persisted session")
	}
	if got.AgentID != "a1" {
		t.Errorf("reloaded AgentID = %q, want a1", got.AgentID)
	}
}

func TestStore_Delete(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir, 100, time.Hour)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	id := "delete-me"
	if err := s.Put(id, &SessionData{SessionID: id}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if _, ok := s.Get(id); !ok {
		t.Fatal("expected session before Delete")
	}
	if err := s.Delete(id); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, ok := s.Get(id); ok {
		t.Error("Get after Delete: still present")
	}
	// File on disk should also be gone.
	if _, err := os.Stat(filepath.Join(dir, id+".json")); !os.IsNotExist(err) {
		t.Errorf("expected session file removed, got stat err=%v", err)
	}
}

func TestStore_ListReturnsCount(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir, 100, time.Hour)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	for i := 0; i < 3; i++ {
		_ = s.Put("list-"+string(rune('a'+i)), &SessionData{})
	}
	if got := s.Count(); got != 3 {
		t.Errorf("Count = %d, want 3", got)
	}
}

func TestStore_ArchiveOldestWhenOverCapacity(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir, 2, time.Hour)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	_ = s.Put("s1", &SessionData{SessionID: "s1"})
	_ = s.Put("s2", &SessionData{SessionID: "s2"})
	_ = s.Put("s3", &SessionData{SessionID: "s3"})

	// ArchiveOldest returns the ids that should be archived (it does
	// NOT mutate the map — callers are responsible for the actual
	// removal). With maxCount=2 and 3 sessions, it should return
	// exactly one id.
	archived := s.ArchiveOldest()
	if len(archived) != 1 {
		t.Fatalf("ArchiveOldest returned %d ids, want 1", len(archived))
	}
	// The returned id must be one of the live sessions.
	if _, ok := s.sessions[archived[0]]; !ok {
		t.Errorf("returned id %q is not a live session", archived[0])
	}
	// And the map should be unchanged (still 3) — ArchiveOldest is
	// advisory only.
	if got := s.Count(); got != 3 {
		t.Errorf("ArchiveOldest mutated map: Count=%d, want 3", got)
	}
}

func TestStore_ArchiveOldestNoopWhenUnderCapacity(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir, 10, time.Hour)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	_ = s.Put("s1", &SessionData{SessionID: "s1"})
	if got := s.ArchiveOldest(); len(got) != 0 {
		t.Errorf("ArchiveOldest under capacity = %v, want empty", got)
	}
}

func TestStore_CleanupExpiredRemovesIdleSessions(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir, 100, 10*time.Millisecond)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	// Put does NOT auto-stamp LastAccessTime (callers set it). Pass an
	// explicit idle timestamp for the entry we want to expire, and
	// time.Now() for the entry we want to keep.
	expired := &SessionData{
		SessionID:      "expire-me",
		LastAccessTime: time.Now().Add(-time.Hour),
	}
	keep := &SessionData{
		SessionID:      "keep-me",
		LastAccessTime: time.Now(),
	}
	_ = s.Put("expire-me", expired)
	_ = s.Put("keep-me", keep)

	removed := s.CleanupExpired()

	found := false
	for _, id := range removed {
		if id == "expire-me" {
			found = true
		}
	}
	if !found {
		t.Errorf("removed = %v, want to contain expire-me", removed)
	}
	if _, ok := s.Get("keep-me"); !ok {
		t.Error("keep-me was incorrectly expired")
	}
}
