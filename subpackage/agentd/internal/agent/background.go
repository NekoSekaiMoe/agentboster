//go:build linux

// Package agent — background.go
//
// Shared long-lived-process helpers used by both the CodeAct tool layer
// (tools_exec.go's exec_background / exec_background_status /
// exec_background_stop) and the HTTP surface (server/processes.go).
//
// Previously the spawn/status/stop logic was inlined inside tool handler
// closures, which made it impossible for the new /api/v1/processes HTTP
// route to drive the same BackgroundTaskStore without duplicating the
// nohup / kill-ladder / tail logic. This file is the extracted, single
// owner of that logic. The tool handlers and the HTTP handlers now both
// call into here; behavior is unchanged for the tool path.
//
// All commands run INSIDE the sandbox via `sbMgr.Exec`. agentd itself
// never holds a host-side *os.Process for these background tasks — the
// PID stored on BackgroundTask is the container-namespace PID, and we
// probe / signal it via `docker exec kill …`. This is why the helpers
// take a *sandbox.Manager rather than a host exec primitive.
package agent

import (
	"fmt"
	"log/slog"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/persistence"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
)

// BackgroundTaskStoreAlias re-exports persistence.BackgroundTaskStore under
// the agent package, so server-side callers can reference it as
// agent.BackgroundTaskStoreAlias without importing persistence directly.
// Keeping the indirection in one place means a future store swap only
// touches this file.
type BackgroundTaskStoreAlias = persistence.BackgroundTaskStore

// BackgroundSpawnResult is what SpawnBackground hands back to callers.
// Exposed fields mirror what the tool / HTTP responses need to surface.
type BackgroundSpawnResult struct {
	Task    *persistence.BackgroundTask
	LogPath string
}

// shellQuote makes a single shell-safe token from an arbitrary string.
//
// Go's %q is NOT a safe substitute here: it produces a double-quoted
// string, which under sh/bash expands $VAR, `backticks`, and $(...),
// fails on \uXXXX escapes (bash double-quotes don't decode them — non-
// ASCII paths get corrupted), and re-escapes \t / \n in ways that change
// meaning. The safe primitive is single-quote wrapping: inside single
// quotes the shell performs NO expansion or interpretation, so the only
// transformation we need is to escape a literal single-quote by closing
// the quote, emitting an escaped quote, and reopening.
//
// We use this for every value we interpolate into a sh -c string
// (logDir, logPath, and the user command) so a malicious or
// special-character-bearing path/command can't break out of its argument
// or smuggle a separate command.
func shellQuote(s string) string {
	// Each single quote becomes: close-quote, backslash-quote, reopen-quote.
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

// SpawnBackground forks `command` inside the sandbox referenced by
// sandboxID, persists a fresh BackgroundTask row, and returns it.
//
// The fork is the same nohup pattern the legacy tool used:
//
//	mkdir -p /tmp/agentd-bg/<id> && nohup bash -c '<cmd>' > <log> 2>&1 & echo $!
//
// so stdout+stderr are merged into <logPath> and the shell prints the
// child PID to the setup command's stdout (parsed into BackgroundTask.PID).
//
// sessionID / sandboxID must be non-empty; callers that don't know the
// sandbox yet must resolve it before calling.
func SpawnBackground(
	sbMgr *sandbox.Manager,
	store *persistence.BackgroundTaskStore,
	sessionID, sandboxID, command string,
) (*BackgroundSpawnResult, error) {
	if sbMgr == nil {
		return nil, fmt.Errorf("sandbox manager unavailable")
	}
	if sandboxID == "" {
		return nil, fmt.Errorf("no sandbox for session")
	}

	bgTaskID := fmt.Sprintf("bg_%d", time.Now().UnixNano())
	logDir := filepath.Join("/tmp", "agentd-bg", bgTaskID)
	logPath := filepath.Join(logDir, "output.log")

	// mkdir + nohup + capture PID. The shell prints the PID on its own
	// line, so trimming stdout gives us a clean integer (or 0 on parse
	// failure, which is tolerated — status then relies on the log file).
	// logDir/logPath are shellQuote'd (not %q'd) so paths with spaces,
	// $, backticks, or non-ASCII chars can't break out of their argument
	// or trigger expansion. `command` is wrapped in single quotes too so
	// it is passed verbatim to `bash -c`; the user's command keeps its
	// own shell semantics but can't inject into the outer mkdir/redirect.
	setupCmd := fmt.Sprintf(
		"mkdir -p %s && nohup bash -c %s > %s 2>&1 & echo $!",
		shellQuote(logDir), shellQuote(command), shellQuote(logPath),
	)
	result, err := sbMgr.Exec(sandboxID, setupCmd, nil, 10)
	if err != nil {
		return nil, fmt.Errorf("exec error: %w", err)
	}

	pidStr := strings.TrimSpace(result.Stdout)
	pid, parseErr := strconv.Atoi(pidStr)
	if parseErr != nil {
		pid = 0
	}

	task := &persistence.BackgroundTask{
		ID:        bgTaskID,
		SessionID: sessionID,
		SandboxID: sandboxID,
		Command:   command,
		PID:       pid,
		LogPath:   logPath,
		Status:    "running",
		StartedAt: time.Now(),
	}
	if store != nil {
		if err := store.Save(task); err != nil {
			// Persistence failure is non-fatal — the task is running, we
			// just can't track it across restarts. Log and continue so the
			// caller still gets the id + log path.
			slog.Warn("background: failed to persist task",
				"id", bgTaskID, "error", err)
		}
	}

	slog.Info("background: started",
		"bg_task_id", bgTaskID, "pid", pid, "session", sessionID)

	return &BackgroundSpawnResult{Task: task, LogPath: logPath}, nil
}

// BackgroundStatus is the polling-friendly snapshot returned by
// StatusBackground. It carries the persisted row plus a freshly-read tail
// of the log so callers don't have to issue a second sandbox exec.
type BackgroundStatus struct {
	Task       *persistence.BackgroundTask
	Alive      bool
	LastOutput string
}

// StatusBackground probes one background task: checks liveness via
// `kill -0 <pid>` and tails up to 4KB of the log file. When the probe
// detects the process has exited, the persisted row is updated to
// status="completed" (idempotent — re-probing a completed task is cheap).
//
// IMPORTANT (process-leak guard): a task is only flipped to "completed"
// when the liveness probe actually ran and returned a definitive "dead".
// If the probe could not run at all (no sandbox manager, no sandbox id,
// PID==0, or sbMgr.Exec returned an error), the task is left in its
// current status. Previously `status.Alive` defaulted to false, so any
// probe failure was misread as "process is dead" → the task got marked
// completed → StopBackground then no-op'd on the non-running status and
// the real process leaked. "probe unavailable" must not look like
// "probe says dead".
//
// Returns (nil, false) when the task id is unknown to the store.
func StatusBackground(
	sbMgr *sandbox.Manager,
	store *persistence.BackgroundTaskStore,
	id string,
) (*BackgroundStatus, bool) {
	if store == nil {
		return nil, false
	}
	task, ok := store.Load(id)
	if !ok {
		return nil, false
	}

	status := &BackgroundStatus{Task: task}

	// probedDead is true ONLY when a liveness probe actually executed and
	// came back with an explicit "dead" verdict. It stays false when the
	// probe was skipped or errored, so the completion reconciliation below
	// leaves the task alone in that case.
	probedDead := false
	if sbMgr != nil && task.SandboxID != "" && task.PID > 0 {
		checkResult, err := sbMgr.Exec(
			task.SandboxID,
			fmt.Sprintf("kill -0 %d 2>/dev/null && echo alive || echo dead", task.PID),
			nil, 5,
		)
		if err == nil {
			switch strings.TrimSpace(checkResult.Stdout) {
			case "alive":
				status.Alive = true
			case "dead":
				status.Alive = false
				probedDead = true
			}
		}
	}

	if sbMgr != nil && task.SandboxID != "" {
		tailResult, err := sbMgr.Exec(
			task.SandboxID,
			fmt.Sprintf("tail -c 4096 %s 2>/dev/null || echo '(no output yet)'", shellQuote(task.LogPath)),
			nil, 5,
		)
		if err == nil {
			status.LastOutput = tailResult.Stdout
		}
	}

	// Reconcile persisted status with the live probe. Only flip running→
	// completed; we never resurrect a task the operator already marked
	// completed / orphaned. Guard on probedDead (not !Alive) so a probe
	// that couldn't run doesn't prematurely complete (and thereby leak)
	// the process — see the doc comment above.
	if task.Status == "running" && probedDead {
		task.Status = "completed"
		task.CompletedAt = time.Now()
		_ = store.Save(task)
	}

	return status, true
}

// StopBackground terminates a background task.
//
// Return contract (stopped, found):
//   - (false, false): task id is unknown to the store (NOT a stop failure).
//   - (true,  true):  task was found and has been marked completed. For a
//                     running task this means we sent SIGTERM and arranged
//                     for a SIGKILL escalation; for an already-completed
//                     task it's an immediate idempotent success.
//   - (false, true):  task was found but we cannot stop it (no sandbox
//                     manager, no sandbox id, or no known PID). The task
//                     is NOT marked completed — callers should treat this
//                     as a conflict / server error, not as 404.
//
// The signal ladder is TERM now, KILL later: StopBackground sends SIGTERM
// synchronously and returns immediately (so the HTTP handler isn't
// blocked for the grace period), then a background goroutine waits out a
// short grace window and escalates to SIGKILL if the PID is still alive.
// This keeps the post-condition "the task is on its way out" true while
// not consuming an HTTP handler goroutine for 5s. Callers that need to
// know the process is fully gone should re-poll StatusBackground.
func StopBackground(
	sbMgr *sandbox.Manager,
	store *persistence.BackgroundTaskStore,
	id string,
) (bool, bool) {
	if store == nil {
		return false, false
	}
	task, ok := store.Load(id)
	if !ok {
		// Unknown id.
		return false, false
	}
	if task.Status != "running" {
		// Already completed / stopped — idempotent success.
		return true, true
	}
	if sbMgr == nil || task.SandboxID == "" || task.PID <= 0 {
		// Found the task but we have no way to signal it. Distinct from
		// "unknown id": the caller knows the id is valid, we just can't
		// honor the stop. Map to 409/500 upstream, not 404.
		return false, true
	}

	// SIGTERM (synchronous, fast). We don't treat a TERM error as fatal —
	// the process may already be gone; the KILL escalation + status probe
	// below is the source of truth.
	_, _ = sbMgr.Exec(
		task.SandboxID,
		fmt.Sprintf("kill -TERM %d 2>/dev/null; true", task.PID),
		nil, 5,
	)

	// Mark completed now so list/status views reflect the stop and
	// repeated calls are idempotent. The actual process may still be
	// draining in the grace window; that's fine — "completed" here means
	// "agentd is done with it", not "the PID has been reaped".
	task.Status = "completed"
	task.CompletedAt = time.Now()
	_ = store.Save(task)

	// Escalate to SIGKILL in the background after the grace period. We
	// snapshot the fields the goroutine needs so it doesn't race a later
	// store mutation / reuse of the task struct. Re-checking liveness with
	// `kill -0` before KILL avoids a spurious KILL against a PID that was
	// already reaped (or, worst case, recycled — the check limits the
	// damage window to the grace period).
	sbMgrBg := sbMgr
	sandboxID := task.SandboxID
	pid := task.PID
	bgID := id
	go func() {
		timer := time.NewTimer(stopBackgroundGrace)
		defer timer.Stop()
		<-timer.C
		_, _ = sbMgrBg.Exec(
			sandboxID,
			fmt.Sprintf("kill -0 %d 2>/dev/null && kill -KILL %d 2>/dev/null; true", pid, pid),
			nil, 10,
		)
		slog.Debug("background: kill-ladder finished", "bg_task_id", bgID, "pid", pid)
	}()

	slog.Info("background: stop issued (TERM sent, KILL queued)",
		"bg_task_id", id, "pid", task.PID, "session", task.SessionID)
	return true, true
}

// stopBackgroundGrace is how long StopBackground's background goroutine
// waits after SIGTERM before escalating to SIGKILL. Matches the legacy
// sleep-5 ladder so process behavior is unchanged; only the caller no
// longer blocks for this duration.
const stopBackgroundGrace = 5 * time.Second
