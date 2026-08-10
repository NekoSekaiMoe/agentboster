//go:build linux
// +build linux

package sandbox

import (
	"testing"
	"time"
)

// TestCleanupReleased_RemovesFreeEntries covers the pre-existing
// behavior: released locks and lazily-created-never-acquired entries are
// swept; active locks survive.
func TestCleanupReleased_RemovesFreeEntries(t *testing.T) {
	t.Parallel()
	r := NewWorkspaceLockRegistry()
	now := time.Now()

	// Free entry (Get-created, never acquired).
	r.Get("ws-free")

	// Released entry: acquire then release.
	if _, ok, err := r.Get("ws-released").TryAcquire("ws-released", "chat_run", "sess-1", "", time.Minute, 1, now); !ok || err != nil {
		t.Fatalf("acquire ws-released: ok=%v err=%v", ok, err)
	}
	if !r.Get("ws-released").Release("sess-1") {
		t.Fatal("release ws-released failed")
	}

	// Active entry: held, unexpired.
	if _, ok, err := r.Get("ws-active").TryAcquire("ws-active", "chat_run", "sess-2", "", time.Minute, 1, now); !ok || err != nil {
		t.Fatalf("acquire ws-active: ok=%v err=%v", ok, err)
	}

	if removed := r.CleanupReleased(now); removed != 2 {
		t.Errorf("CleanupReleased removed %d; want 2", removed)
	}
	if r.Snapshot("ws-active") == nil {
		t.Error("active lock must be preserved")
	}
	// Swept entries are gone from the registry (Snapshot does not
	// recreate them).
	if r.lookup("ws-free") != nil || r.lookup("ws-released") != nil {
		t.Error("free entries must be deleted from the registry")
	}
}

// TestCleanupReleased_RemovesExpiredEntries verifies locks whose state
// is non-nil but expired (ttl set, ExpiresAt in the past) are swept with
// the same expiry semantics as TryAcquire.
func TestCleanupReleased_RemovesExpiredEntries(t *testing.T) {
	t.Parallel()
	r := NewWorkspaceLockRegistry()
	acquiredAt := time.Now()

	// Lock with a 1-minute ttl — expired 1 second after ExpiresAt.
	if _, ok, err := r.Get("ws-expired").TryAcquire("ws-expired", "chat_run", "sess-1", "", time.Minute, 1, acquiredAt); !ok || err != nil {
		t.Fatalf("acquire ws-expired: ok=%v err=%v", ok, err)
	}

	// Just before expiry: retained.
	beforeExpiry := acquiredAt.Add(30 * time.Second)
	if removed := r.CleanupReleased(beforeExpiry); removed != 0 {
		t.Errorf("before expiry: removed %d; want 0", removed)
	}
	if r.Snapshot("ws-expired") == nil {
		t.Error("unexpired lock must be preserved before expiry")
	}

	// After expiry: swept.
	afterExpiry := acquiredAt.Add(2 * time.Minute)
	if removed := r.CleanupReleased(afterExpiry); removed != 1 {
		t.Errorf("after expiry: removed %d; want 1", removed)
	}
	if r.lookup("ws-expired") != nil {
		t.Error("expired lock must be deleted from the registry")
	}
}

// TestCleanupReleased_ZeroExpiresAtNeverExpires mirrors TryAcquire's
// ttl>0 gate: a lock acquired with ttl<=0 has a zero ExpiresAt and must
// never be swept as expired.
func TestCleanupReleased_ZeroExpiresAtNeverExpires(t *testing.T) {
	t.Parallel()
	r := NewWorkspaceLockRegistry()
	acquiredAt := time.Now()

	if _, ok, err := r.Get("ws-noexpiry").TryAcquire("ws-noexpiry", "chat_run", "sess-1", "", 0, 1, acquiredAt); !ok || err != nil {
		t.Fatalf("acquire ws-noexpiry: ok=%v err=%v", ok, err)
	}

	farFuture := acquiredAt.Add(24 * time.Hour)
	if removed := r.CleanupReleased(farFuture); removed != 0 {
		t.Errorf("removed %d; want 0 (zero ExpiresAt never expires)", removed)
	}
	if r.Snapshot("ws-noexpiry") == nil {
		t.Error("ttl<=0 lock must be preserved")
	}
}

// TestCleanupReleased_MixedRegistry exercises all four entry kinds in one
// sweep and checks the returned count.
func TestCleanupReleased_MixedRegistry(t *testing.T) {
	t.Parallel()
	r := NewWorkspaceLockRegistry()
	now := time.Now()

	r.Get("ws-free") // never acquired → swept
	if _, ok, _ := r.Get("ws-expired").TryAcquire("ws-expired", "chat_run", "s1", "", time.Minute, 1, now); !ok {
		t.Fatal("acquire ws-expired failed")
	}
	if _, ok, _ := r.Get("ws-active").TryAcquire("ws-active", "chat_run", "s2", "", time.Hour, 1, now); !ok {
		t.Fatal("acquire ws-active failed")
	}
	if _, ok, _ := r.Get("ws-noexpiry").TryAcquire("ws-noexpiry", "chat_run", "s3", "", 0, 1, now); !ok {
		t.Fatal("acquire ws-noexpiry failed")
	}

	sweep := now.Add(2 * time.Minute) // past ws-expired's ttl, before ws-active's
	if removed := r.CleanupReleased(sweep); removed != 2 {
		t.Errorf("removed %d; want 2 (free + expired)", removed)
	}
	if r.Snapshot("ws-active") == nil || r.Snapshot("ws-noexpiry") == nil {
		t.Error("active and non-expiring locks must survive the sweep")
	}
}

// TestTryAcquire_ExpiredLockStealable documents the expiry semantics
// CleanupReleased mirrors: a TryAcquire past ExpiresAt steals the lock.
func TestTryAcquire_ExpiredLockStealable(t *testing.T) {
	t.Parallel()
	lock := NewWorkspaceLock()
	t0 := time.Now()

	if _, ok, err := lock.TryAcquire("ws", "chat_run", "sess-1", "", time.Minute, 1, t0); !ok || err != nil {
		t.Fatalf("first acquire: ok=%v err=%v", ok, err)
	}
	// Held by sess-1, unexpired: second session is busy.
	if state, ok, err := lock.TryAcquire("ws", "chat_run", "sess-2", "", time.Minute, 2, t0.Add(30*time.Second)); ok || err != nil {
		t.Fatalf("busy acquire: ok=%v err=%v", ok, err)
	} else if state.ExecSessionID != "sess-1" {
		t.Errorf("busy holder = %q; want sess-1", state.ExecSessionID)
	}
	// Past expiry: sess-2 steals.
	if state, ok, err := lock.TryAcquire("ws", "chat_run", "sess-2", "", time.Minute, 2, t0.Add(2*time.Minute)); !ok || err != nil {
		t.Fatalf("steal acquire: ok=%v err=%v", ok, err)
	} else if state.ExecSessionID != "sess-2" {
		t.Errorf("new holder = %q; want sess-2", state.ExecSessionID)
	}
}
