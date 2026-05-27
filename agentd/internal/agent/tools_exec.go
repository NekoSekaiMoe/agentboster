package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/clawless/agentd/internal/persistence"
	"github.com/clawless/agentd/internal/sandbox"
)

func registerExec(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "exec",
		Description: "Execute a shell command in the sandbox. Returns stdout, stderr, and exit code.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"command":     map[string]any{"type": "string", "description": "Shell command to execute"},
				"timeout":     map[string]any{"type": "integer", "description": "Timeout in seconds (default 60)", "default": 60},
				"working_dir": map[string]any{"type": "string", "description": "Working directory (relative to sandbox workspace)", "default": "."},
			},
			"required": []string{"command"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Command    string `json:"command"`
			Timeout    int    `json:"timeout"`
			WorkingDir string `json:"working_dir"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		if params.Timeout <= 0 {
			params.Timeout = 60
		}

		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		result, err := sbMgr.Exec(sandboxID, params.Command, nil, params.Timeout)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("exec error: %v", err)}, nil
		}

		output := result.Stdout
		if result.ExitCode != 0 {
			output = fmt.Sprintf("[exit code: %d]\n%s\n[stderr]\n%s", result.ExitCode, result.Stdout, result.Stderr)
		}

		slog.Info("exec", "command", params.Command, "exit_code", result.ExitCode, "duration", result.Duration)
		return &ToolResult{Success: result.ExitCode == 0, Data: output}, nil
	})
}

func registerExecBackground(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	// exec_background: start a long-running command with persistent tracking
	registry.Register(ToolDefinition{
		Name:        "exec_background",
		Description: "Start a long-running command in the background. Returns a background task ID and PID. Use exec_background_status to check progress and exec_background_stop to terminate.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"command": map[string]any{"type": "string", "description": "Shell command to run in background"},
			},
			"required": []string{"command"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Command string `json:"command"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		// Unique log path per background task to avoid collisions
		bgTaskID := fmt.Sprintf("bg_%d", time.Now().UnixNano())
		logDir := filepath.Join("/tmp", "agentd-bg", bgTaskID)
		logPath := filepath.Join(logDir, "output.log")

		// Create log directory and start background process
		setupCmd := fmt.Sprintf("mkdir -p %q && nohup bash -c %q > %q 2>&1 & echo $!", logDir, params.Command, logPath)
		result, err := sbMgr.Exec(sandboxID, setupCmd, nil, 10)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("exec error: %v", err)}, nil
		}

		pidStr := strings.TrimSpace(result.Stdout)
		pid, parseErr := strconv.Atoi(pidStr)
		if parseErr != nil {
			pid = 0
		}

		// Persist background task state
		if ctx.BGTaskStore != nil {
			bgTask := &persistence.BackgroundTask{
				ID:        bgTaskID,
				SessionID: ctx.SessionID,
				SandboxID: sandboxID,
				Command:   params.Command,
				PID:       pid,
				LogPath:   logPath,
				Status:    "running",
				StartedAt: time.Now(),
			}
			if err := ctx.BGTaskStore.Save(bgTask); err != nil {
				slog.Warn("failed to persist background task", "id", bgTaskID, "error", err)
			}
		}

		slog.Info("exec_background started", "bg_task_id", bgTaskID, "pid", pid, "session", ctx.SessionID)
		return &ToolResult{
			Success: true,
			Data: fmt.Sprintf(
				"Background task started.\nTask ID: %s\nPID: %d\nLog: %s\n\nUse exec_background_status with task_id=\"%s\" to check progress.\nUse exec_background_stop with task_id=\"%s\" to terminate.",
				bgTaskID, pid, logPath, bgTaskID, bgTaskID,
			),
		}, nil
	})

	// exec_background_status: check status of a background task
	registry.Register(ToolDefinition{
		Name:        "exec_background_status",
		Description: "Check the status of a background task started by exec_background. Returns PID, status, and recent output.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"task_id": map[string]any{"type": "string", "description": "Background task ID returned by exec_background"},
			},
			"required": []string{"task_id"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			TaskID string `json:"task_id"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		// Try to load from persistent store first
		if ctx.BGTaskStore == nil {
			return &ToolResult{Success: false, Error: "background task store not available"}, nil
		}

		bgTask, ok := ctx.BGTaskStore.Load(params.TaskID)
		if !ok {
			return &ToolResult{Success: false, Error: fmt.Sprintf("background task %s not found", params.TaskID)}, nil
		}

		// Check if process is still alive
		alive := false
		if bgTask.PID > 0 {
			checkResult, err := sbMgr.Exec(sandboxID, fmt.Sprintf("kill -0 %d 2>/dev/null && echo alive || echo dead", bgTask.PID), nil, 5)
			if err == nil {
				alive = strings.TrimSpace(checkResult.Stdout) == "alive"
			}
		}

		// Read last 4KB of output
		tailResult, err := sbMgr.Exec(sandboxID, fmt.Sprintf("tail -c 4096 %q 2>/dev/null || echo '(no output yet)'", bgTask.LogPath), nil, 5)
		lastOutput := ""
		if err == nil {
			lastOutput = tailResult.Stdout
		}

		status := bgTask.Status
		if status == "running" && !alive {
			status = "completed"
			bgTask.Status = "completed"
			bgTask.CompletedAt = time.Now()
			ctx.BGTaskStore.Save(bgTask)
		}

		data := fmt.Sprintf("Task ID: %s\nPID: %d\nStatus: %s\nAlive: %t\n\n--- Last Output ---\n%s",
			bgTask.ID, bgTask.PID, status, alive, lastOutput)

		return &ToolResult{Success: true, Data: data}, nil
	})

	// exec_background_stop: terminate a background task
	registry.Register(ToolDefinition{
		Name:        "exec_background_stop",
		Description: "Stop a running background task by its task ID. Sends SIGTERM, then SIGKILL after 5 seconds if still alive.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"task_id": map[string]any{"type": "string", "description": "Background task ID returned by exec_background"},
			},
			"required": []string{"task_id"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			TaskID string `json:"task_id"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		if ctx.BGTaskStore == nil {
			return &ToolResult{Success: false, Error: "background task store not available"}, nil
		}

		bgTask, ok := ctx.BGTaskStore.Load(params.TaskID)
		if !ok {
			return &ToolResult{Success: false, Error: fmt.Sprintf("background task %s not found", params.TaskID)}, nil
		}

		if bgTask.Status != "running" {
			return &ToolResult{Success: true, Data: fmt.Sprintf("Task %s is already %s", params.TaskID, bgTask.Status)}, nil
		}

		// Send SIGTERM, wait 5s, then SIGKILL
		killCmd := fmt.Sprintf("kill %d 2>/dev/null; sleep 5; kill -0 %d 2>/dev/null && kill -9 %d 2>/dev/null; echo done", bgTask.PID, bgTask.PID, bgTask.PID)
		sbMgr.Exec(sandboxID, killCmd, nil, 15)

		bgTask.Status = "completed"
		bgTask.CompletedAt = time.Now()
		ctx.BGTaskStore.Save(bgTask)

		return &ToolResult{Success: true, Data: fmt.Sprintf("Task %s (PID %d) stopped.", params.TaskID, bgTask.PID)}, nil
	})
}
