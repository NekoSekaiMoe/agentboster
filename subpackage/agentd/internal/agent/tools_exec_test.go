//go:build linux

package agent

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/persistence"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/usertype"
)

func TestToolRegistryDisabledToolIsNotRegistered(t *testing.T) {
	registry := NewToolRegistry([]string{"exec"})
	registry.Register(ToolDefinition{Name: "exec"}, func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{Success: true}, nil
	})

	if _, _, ok := registry.Get("exec"); ok {
		t.Fatalf("disabled tool should not be registered")
	}
}

func TestToolDefaultMinUserTypeRequiresUser(t *testing.T) {
	registry := NewToolRegistry()
	registry.Register(ToolDefinition{Name: "exec"}, func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{Success: true}, nil
	})

	def, _, ok := registry.Get("exec")
	if !ok {
		t.Fatalf("tool not registered")
	}
	if def.MinUserType != string(usertype.User) {
		t.Fatalf("expected default min user type user, got %q", def.MinUserType)
	}
	if usertype.CanUse(nil, def.MinUserType) {
		t.Fatalf("unknown user should not be allowed to execute default user tool")
	}
}

// newTestBGStore builds an on-disk BackgroundTaskStore under a temp dir.
func newTestBGStore(t *testing.T) *persistence.BackgroundTaskStore {
	t.Helper()
	store, err := persistence.NewBackgroundTaskStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewBackgroundTaskStore: %v", err)
	}
	return store
}

// TestStopBackgroundUnknownIDReturnsNotFoundNotFoundStopped covers the
// return-contract bug: an unknown id must return (stopped=false, found=false)
// — NOT (false, true). handleStopProcess maps these differently (404 vs
// 409), so conflating them would misreport a real stop failure as a
// missing-id. No sandbox manager needed for the unknown-id path.
func TestStopBackgroundUnknownIDReturnsNotFoundNotFoundStopped(t *testing.T) {
	store := newTestBGStore(t)
	stopped, found := StopBackground(nil, store, "does-not-exist")
	if stopped || found {
		t.Fatalf("StopBackground(unknown id) = (stopped=%v, found=%v), want (false, false)",
			stopped, found)
	}
}

// TestStopBackgroundNoSandboxReturnsFoundButNotStopped covers the second
// arm of the contract: the task EXISTS and is running, but we have no way
// to signal it (no sandbox manager). This must return (false, true) so
// handleStopProcess can map it to 409 Conflict, NOT 404. Previously the
// status was pre-emptively marked completed by StatusBackground, then
// StopBackground saw status!=running and returned (true, true) — masking
// the failure. With the leak fix, a running task with no sandbox stays
// running and StopBackground reports the genuine failure.
func TestStopBackgroundNoSandboxReturnsFoundButNotStopped(t *testing.T) {
	store := newTestBGStore(t)
	task := &persistence.BackgroundTask{
		ID: "bg_test", SessionID: "s", SandboxID: "sb", PID: 123,
		Status: "running", StartedAt: time.Now(),
	}
	if err := store.Save(task); err != nil {
		t.Fatalf("Save: %v", err)
	}

	stopped, found := StopBackground(nil, store, "bg_test")
	if stopped || !found {
		t.Fatalf("StopBackground(running, no sbMgr) = (stopped=%v, found=%v), want (false, true)",
			stopped, found)
	}
	// And the task must still be running (we couldn't stop it).
	after, ok := store.Load("bg_test")
	if !ok {
		t.Fatalf("task disappeared")
	}
	if after.Status != "running" {
		t.Fatalf("task status = %q, want still \"running\" (we could not actually stop it)", after.Status)
	}
}

// TestStopBackgroundAlreadyCompletedIsIdempotentSuccess verifies the
// already-non-running fast path returns (true, true) without touching the
// sandbox manager.
func TestStopBackgroundAlreadyCompletedIsIdempotentSuccess(t *testing.T) {
	store := newTestBGStore(t)
	task := &persistence.BackgroundTask{
		ID: "bg_done", SessionID: "s", SandboxID: "sb", PID: 0,
		Status: "completed", StartedAt: time.Now(),
	}
	if err := store.Save(task); err != nil {
		t.Fatalf("Save: %v", err)
	}

	stopped, found := StopBackground(nil, store, "bg_done")
	if !stopped || !found {
		t.Fatalf("StopBackground(completed) = (stopped=%v, found=%v), want (true, true)",
			stopped, found)
	}
}

// TestStatusBackgroundLeavesRunningWhenProbeUnavailable covers the
// process-leak guard (bug 6): a task whose liveness probe CANNOT run
// (PID==0 here) must NOT be flipped to completed, because that would
// make StopBackground no-op and the real process would leak. Previously
// status.Alive defaulted false, so !Alive completed the task.
func TestStatusBackgroundLeavesRunningWhenProbeUnavailable(t *testing.T) {
	store := newTestBGStore(t)
	task := &persistence.BackgroundTask{
		ID: "bg_noprobe", SessionID: "s", SandboxID: "sb", PID: 0,
		LogPath: "/tmp/x.log", Status: "running", StartedAt: time.Now(),
	}
	if err := store.Save(task); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// sbMgr is nil -> probe skipped entirely; task must stay running.
	status, ok := StatusBackground(nil, store, "bg_noprobe")
	if !ok || status == nil {
		t.Fatalf("StatusBackground = (_, %v), want found", ok)
	}
	if status.Alive {
		t.Fatalf("Alive = true; want false (no probe ran, default zero value)")
	}
	if status.Task.Status != "running" {
		t.Fatalf("status flipped to %q; want \"running\" (probe unavailable must not complete)", status.Task.Status)
	}
}
