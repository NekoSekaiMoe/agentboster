//go:build linux

package l2_auth

import (
	"testing"
	"time"

	"github.com/clawless/agentd/internal/clawless"
)

func TestAlwaysAuthorizationLastsForSessionLifetime(t *testing.T) {
	mgr := NewL2AuthManager(nil, "agent-1")
	task := &clawless.Task{
		ID:        "task-1",
		UserID:    "user-1",
		SessionID: "session-1",
		SandboxID: "sandbox-1",
		Command:   "rm -rf ./build",
		Roles:     []string{"root"},
	}

	mgr.RememberPendingTask(task)
	if err := mgr.AuthorizeTask(task.ID, task.Command, "always"); err != nil {
		t.Fatalf("authorize always: %v", err)
	}

	entry, hit, rejected := mgr.CheckTask(task)
	if !hit {
		t.Fatal("expected always authorization to hit")
	}
	if rejected {
		t.Fatal("expected pass authorization, got reject")
	}
	if !entry.ExpiresAt.Equal(sessionLifetimeExpiry) {
		t.Fatalf("expected session lifetime expiry, got %s", entry.ExpiresAt.Format(time.RFC3339))
	}

	mgr.ClearSession(task.SessionID)
	if _, hit, _ := mgr.CheckTask(task); hit {
		t.Fatal("expected session authorization to be cleared")
	}
}

func TestTimedAuthorizationUsesExplicitDuration(t *testing.T) {
	mgr := NewL2AuthManager(nil, "agent-1")
	task := &clawless.Task{
		ID:        "task-2",
		UserID:    "user-1",
		SessionID: "session-1",
		SandboxID: "sandbox-1",
		Command:   "rm -rf ./build",
		Roles:     []string{"root"},
	}

	before := time.Now()
	mgr.RememberPendingTask(task)
	if err := mgr.AuthorizeTask(task.ID, task.Command, "01000000"); err != nil {
		t.Fatalf("authorize duration: %v", err)
	}

	entry, hit, _ := mgr.CheckTask(task)
	if !hit {
		t.Fatal("expected timed authorization to hit")
	}

	min := before.Add(59 * time.Minute)
	max := time.Now().Add(61 * time.Minute)
	if entry.ExpiresAt.Before(min) || entry.ExpiresAt.After(max) {
		t.Fatalf("expected roughly 1 hour expiry, got %s", entry.ExpiresAt.Format(time.RFC3339))
	}
	if entry.ExpiresAt.Equal(sessionLifetimeExpiry) {
		t.Fatal("timed authorization must not use session lifetime expiry")
	}
}
