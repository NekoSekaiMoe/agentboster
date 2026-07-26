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
	setupCmd := fmt.Sprintf(
		"mkdir -p %q && nohup bash -c %q > %q 2>&1 & echo $!",
		logDir, command, logPath,
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

	if sbMgr != nil && task.SandboxID != "" && task.PID > 0 {
		checkResult, err := sbMgr.Exec(
			task.SandboxID,
			fmt.Sprintf("kill -0 %d 2>/dev/null && echo alive || echo dead", task.PID),
			nil, 5,
		)
		if err == nil {
			status.Alive = strings.TrimSpace(checkResult.Stdout) == "alive"
		}
	}

	if sbMgr != nil && task.SandboxID != "" {
		tailResult, err := sbMgr.Exec(
			task.SandboxID,
			fmt.Sprintf("tail -c 4096 %q 2>/dev/null || echo '(no output yet)'", task.LogPath),
			nil, 5,
		)
		if err == nil {
			status.LastOutput = tailResult.Stdout
		}
	}

	// Reconcile persisted status with the live probe. Only flip running→
	// completed; we never resurrect a task the operator already marked
	// completed / orphaned.
	if task.Status == "running" && !status.Alive {
		task.Status = "completed"
		task.CompletedAt = time.Now()
		_ = store.Save(task)
	}

	return status, true
}

// StopBackground terminates a background task. The signal ladder mirrors
// the legacy tool: SIGTERM, sleep 5s, then SIGKILL if the PID is still
// alive. No-op (returns nil) when the task is already non-running.
//
// Returns (false, true) when the task id is unknown. Returns (true, true)
// after the ladder regardless of whether SIGKILL was required — the
// post-condition "task is no longer running" holds.
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
		return false, false
	}
	if task.Status != "running" {
		return true, true
	}
	if sbMgr == nil || task.SandboxID == "" || task.PID <= 0 {
		return false, true
	}

	// TERM
	_, _ = sbMgr.Exec(
		task.SandboxID,
		fmt.Sprintf("kill -TERM %d 2>/dev/null; true", task.PID),
		nil, 5,
	)
	// Grace period, then KILL if still alive. We use `kill -0` (not the
	// log tail) for the liveness check because we only care whether the
	// process is gone, not what it printed while dying.
	_, _ = sbMgr.Exec(
		task.SandboxID,
		fmt.Sprintf("sleep 5; kill -0 %d 2>/dev/null && kill -KILL %d 2>/dev/null; true", task.PID, task.PID),
		nil, 10,
	)

	task.Status = "completed"
	task.CompletedAt = time.Now()
	_ = store.Save(task)

	slog.Info("background: stopped",
		"bg_task_id", id, "pid", task.PID, "session", task.SessionID)
	return true, true
}
