//go:build linux

package agent

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
)

// captureDefaultLogger swaps slog's default logger for one writing to
// buf and returns a restore func. AgentContext.Log()/snapshot.log()
// derive from slog.Default()/slog.With, so swapping the default is how
// tests observe the emitted attributes.
func captureDefaultLogger(buf *bytes.Buffer) func() {
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, nil)))
	return func() { slog.SetDefault(prev) }
}

// TestAgentContextLog_IncludesRunIDWhenSet covers the request-scoped
// logger used by ExecuteTool (manager.go session-persist / workspace
// lazy-create warnings) and AgentLoop.Run (loop.go step/compaction/
// audit lines): when RunID propagates from ToolExecRequest, every log
// line emitted during the task must carry run_id so a long-chain agent
// run can be grepped across both tiers by one id.
func TestAgentContextLog_IncludesRunIDWhenSet(t *testing.T) {
	var buf bytes.Buffer
	t.Cleanup(captureDefaultLogger(&buf))

	ctx := &AgentContext{SessionID: "sess-1", RunID: "run-test-123"}
	ctx.Log().Info("task log line", "session_id", ctx.SessionID)

	out := buf.String()
	if !strings.Contains(out, "run_id=run-test-123") {
		t.Fatalf("expected run_id attribute in log output, got: %s", out)
	}
	if !strings.Contains(out, "session_id=sess-1") {
		t.Fatalf("expected original attributes preserved, got: %s", out)
	}
}

// TestAgentContextLog_DefaultWhenRunIDEmpty pins the legacy behavior:
// older Web callers pass no run_id, and their log shape must stay
// byte-for-byte identical (no empty run_id= attribute).
func TestAgentContextLog_DefaultWhenRunIDEmpty(t *testing.T) {
	ctx := &AgentContext{SessionID: "sess-1"}
	if ctx.Log() != slog.Default() {
		t.Fatalf("expected slog.Default() when RunID is empty")
	}

	var buf bytes.Buffer
	t.Cleanup(captureDefaultLogger(&buf))
	ctx.Log().Warn("legacy warning", "session_id", ctx.SessionID)
	if strings.Contains(buf.String(), "run_id") {
		t.Fatalf("empty RunID must not emit a run_id attribute, got: %s", buf.String())
	}

	// Nil context is defensive-only (detached paths); must not panic.
	var nilCtx *AgentContext
	if nilCtx.Log() != slog.Default() {
		t.Fatalf("nil context must fall back to slog.Default()")
	}
}

func TestTraceCallbacksCarryRunID(t *testing.T) {
	startedAt := time.Unix(1_700_000_000, 0)
	completedAt := startedAt.Add(250 * time.Millisecond)
	ctx := &AgentContext{
		TaskID:    "00000000-0000-0000-0000-000000000001",
		SessionID: "sess-1",
		AgentID:   "agent-1",
		UserID:    "user-1",
		Roles:     []string{"admin"},
		RunID:     "run-callback-123",
	}
	activity := buildToolActivityLog(
		ctx,
		"model-1",
		2,
		&ToolCall{ID: "call-1", Name: "read", Arguments: json.RawMessage(`{"path":"README.md"}`)},
		&ToolResult{Success: true, Data: "ok"},
		"ok",
		startedAt,
		completedAt,
	)
	if activity.RunID != ctx.RunID {
		t.Fatalf("tool activity RunID: want %q, got %q", ctx.RunID, activity.RunID)
	}

	reviews := []clawless.ReviewLog{{Command: "read README.md", Level: "L0", Decision: "allowed"}}
	stampReviewLogs(reviews, ctx)
	if reviews[0].RunID != ctx.RunID {
		t.Fatalf("review RunID: want %q, got %q", ctx.RunID, reviews[0].RunID)
	}
	if reviews[0].TaskID != ctx.TaskID || reviews[0].UserID != ctx.UserID {
		t.Fatalf("review identity not stamped: %+v", reviews[0])
	}
}

// TestSubagentParentSnapshot_CarriesRunID is the C11 regression test:
// the snapshot handed to the sub-agent goroutine must carry the parent's
// run id so runSubagentLoop can stamp it onto the sub-agent AgentContext
// (which loop.go then copies onto the per-tool audit clawless.Task).
func TestSubagentParentSnapshot_CarriesRunID(t *testing.T) {
	parent := &AgentContext{
		AgentID:   "agent-1",
		SessionID: "sess-1",
		UserID:    "user-1",
		Roles:     []string{"admin"},
		RunID:     "run-parent-456",
	}
	req := SubagentRequest{
		ID:          "sub-1",
		Task:        "do the thing",
		SandboxType: "auto",
	}

	snap := newSubagentParentSnapshot(parent, req, "")
	if snap.runID != "run-parent-456" {
		t.Fatalf("snapshot runID: want run-parent-456, got %q", snap.runID)
	}
	if snap.subagentID != "sub-1" || snap.task != "do the thing" {
		t.Fatalf("snapshot identity fields wrong: %+v", snap)
	}

	// Roles must be a copy — mutating the snapshot must not leak into
	// the shared parent context.
	snap.roles[0] = "mutated"
	if parent.Roles[0] != "admin" {
		t.Fatalf("snapshot roles slice aliases parent: %v", parent.Roles)
	}
}

// TestSubagentSnapshotLog_RunIDAttr covers the goroutine-side logger
// (subagent loop starting / completed / panicked lines).
func TestSubagentSnapshotLog_RunIDAttr(t *testing.T) {
	var buf bytes.Buffer
	t.Cleanup(captureDefaultLogger(&buf))

	withRun := subagentParentSnapshot{runID: "run-sub-789"}
	withRun.log().Info("subagent loop starting")
	if !strings.Contains(buf.String(), "run_id=run-sub-789") {
		t.Fatalf("expected run_id in subagent log, got: %s", buf.String())
	}

	buf.Reset()
	withoutRun := subagentParentSnapshot{}
	withoutRun.log().Info("subagent loop starting")
	if strings.Contains(buf.String(), "run_id") {
		t.Fatalf("empty runID must not emit run_id attribute, got: %s", buf.String())
	}
}

// TestLaunchSubagent_PropagatesRunID exercises the full LaunchSubagent
// entry point with a run-id-carrying parent: the registry clawless.Task
// and the "subagent launched" log must both carry the run id. The
// manager has a nil sandbox manager, so the spawned goroutine takes the
// recovered-panic path and settles the registry row as completed; the
// test waits for that before reading the captured log buffer so no
// goroutine write races the read.
func TestLaunchSubagent_PropagatesRunID(t *testing.T) {
	var buf bytes.Buffer
	t.Cleanup(captureDefaultLogger(&buf))

	m := &Manager{}
	parent := &AgentContext{
		AgentID:   "agent-1",
		SessionID: "sess-1",
		RunID:     "run-launch-1",
	}

	id := m.LaunchSubagent(parent, SubagentRequest{Task: "t", SandboxType: "auto"})
	if id == "" {
		t.Fatalf("LaunchSubagent returned empty id")
	}

	// Synchronous part: registry registration + launch log happen
	// before the goroutine starts.
	subagentRegistry.mu.RLock()
	task, ok := subagentRegistry.agents[id]
	subagentRegistry.mu.RUnlock()
	if !ok {
		t.Fatalf("subagent %s not registered", id)
	}
	if task.RunID != "run-launch-1" {
		t.Fatalf("registry task RunID: want run-launch-1, got %q", task.RunID)
	}

	// Wait for the goroutine to finish (nil sbManager → recovered panic
	// → storeFinal marks the registry row completed) so all log writes
	// are done before we read the buffer.
	deadline := time.Now().Add(5 * time.Second)
	for {
		subagentRegistry.mu.RLock()
		status := subagentRegistry.agents[id].Status
		subagentRegistry.mu.RUnlock()
		if status == clawless.TaskCompleted {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("subagent goroutine did not settle; status=%q", status)
		}
		time.Sleep(10 * time.Millisecond)
	}

	out := buf.String()
	if !strings.Contains(out, "subagent launched") {
		t.Fatalf("expected 'subagent launched' log line, got: %s", out)
	}
	if !strings.Contains(out, "run_id=run-launch-1") {
		t.Fatalf("expected run_id on subagent lifecycle logs, got: %s", out)
	}
}
