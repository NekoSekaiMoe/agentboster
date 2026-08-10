package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/eventbus"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
)

const (
	defaultExecBatchTimeoutMs = 60_000
	maxExecBatchTimeoutMs     = 600_000
	maxExecBatchCommands      = 16
)

// === Parallel exec ===

// ExecCommand is a single command entry in a parallel exec_batch tool call.
// It is also the payload shape for `eventbus.EventExecRequested` once the
// exec worker pool is wired in (Step 7).
type ExecCommand struct {
	ID                string            `json:"id,omitempty"`                 // ULID, set at submission
	Command           string            `json:"command"`                      // shell command to execute
	WorkDir           string            `json:"work_dir,omitempty"`           // working dir (relative to sandbox workspace)
	Env               map[string]string `json:"env,omitempty"`                // extra env vars
	TimeoutMs         int               `json:"timeout_ms,omitempty"`         // per-command timeout in ms
	SandboxHint       string            `json:"sandbox_hint,omitempty"`       // "auto" | "docker" | "docker-strict" | "lxc" | "inherit"
	PermissionProfile string            `json:"permission_profile,omitempty"` // "default" | "strict" | "network" | "package-install" | "browser" | "persistent"
	UseParentSandbox  bool              `json:"use_parent_sandbox,omitempty"` // true → reuse calling session's lxc container
}

// ExecResult is the per-command result in a parallel exec_batch tool call.
// It is also the payload shape for `eventbus.EventExecCompleted` once the
// exec worker pool is wired in (Step 7).
type ExecResult struct {
	BatchID     string        `json:"batch_id,omitempty"`
	ID          string        `json:"id,omitempty"`
	Index       int           `json:"index"`
	Status      string        `json:"status"`
	ExitCode    int           `json:"exit_code"`
	Stdout      string        `json:"stdout,omitempty"`
	Stderr      string        `json:"stderr,omitempty"`
	Duration    time.Duration `json:"duration,omitempty"`
	DurationMs  int64         `json:"duration_ms,omitempty"`
	Error       string        `json:"error,omitempty"` // populated on infra error (sandbox create failed, etc.)
	SandboxID   string        `json:"sandbox_id,omitempty"`
	SandboxType string        `json:"sandbox_type,omitempty"`
	Truncated   bool          `json:"truncated,omitempty"` // stdout/stderr hit the 100 KiB cap
}

// ExecBatchRequest is the input contract for the parallel exec_batch tool.
type ExecBatchRequest struct {
	Commands  []ExecCommand `json:"commands"`             // at minimum this is required
	FailFast  bool          `json:"fail_fast,omitempty"`  // return after first failure
	TimeoutMs int           `json:"timeout_ms,omitempty"` // per-command timeout fallback (ms)
	WorkDir   string        `json:"work_dir,omitempty"`   // default work dir for all commands
}

// ExecBatchResult is the output contract for the parallel exec_batch tool.
type ExecBatchResult struct {
	BatchID string       `json:"batch_id"`
	Results []ExecResult `json:"results"` // reuses the per-cmd ExecResult
	TotalMs int64        `json:"total_ms"`
	Status  string       `json:"status"` // "completed" | "partial" | "failed"
}

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

		sandboxID := ctx.SnapshotSandboxID()
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
			// P8: surface the categorized cause (timeout / binary-missing /
			// etc.) so the model can self-heal — e.g. retry with a longer
			// timeout vs report a daemon misconfiguration vs accept a plain
			// business error. Previously all four collapsed into an opaque
			// ExitCode=-1 with stdout/stderr merged.
			if result.Err != nil {
				output = fmt.Sprintf("[%v]\n%s", result.Err, output)
			}
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

		sandboxID := ctx.SnapshotSandboxID()
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		result, err := SpawnBackground(sbMgr, ctx.BGTaskStore, ctx.SessionID, sandboxID, params.Command)
		if err != nil {
			return &ToolResult{Success: false, Error: err.Error()}, nil
		}

		return &ToolResult{
			Success: true,
			Data: fmt.Sprintf(
				"Background task started.\nTask ID: %s\nPID: %d\nLog: %s\n\nUse exec_background_status with task_id=\"%s\" to check progress.\nUse exec_background_stop with task_id=\"%s\" to terminate.",
				result.Task.ID, result.Task.PID, result.LogPath, result.Task.ID, result.Task.ID,
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

		status, ok := StatusBackground(sbMgr, ctx.BGTaskStore, params.TaskID)
		if !ok || status == nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("background task %s not found", params.TaskID)}, nil
		}

		data := fmt.Sprintf("Task ID: %s\nPID: %d\nStatus: %s\nAlive: %t\n\n--- Last Output ---\n%s",
			status.Task.ID, status.Task.PID, status.Task.Status, status.Alive, status.LastOutput)

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

		ok, _ := StopBackground(sbMgr, ctx.BGTaskStore, params.TaskID)
		if !ok {
			return &ToolResult{Success: false, Error: fmt.Sprintf("background task %s not found", params.TaskID)}, nil
		}
		return &ToolResult{Success: true, Data: fmt.Sprintf("Task %s stopped.", params.TaskID)}, nil
	})
}

func registerExecBatch(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "exec_batch",
		Description: "Execute multiple shell commands in parallel inside the current sandbox workspace. Returns one ExecResult entry per command.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"commands": map[string]any{
					"type":        "array",
					"description": "List of commands to execute in parallel. Each command may set sandbox_hint (auto/docker/docker-strict/lxc/inherit) and permission_profile (default/strict/network/package-install/browser/persistent). Permission profiles are requests; policy may clamp or escalate them.",
				},
				"fail_fast":  map[string]any{"type": "boolean", "description": "Return as soon as the first command fails"},
				"timeout_ms": map[string]any{"type": "integer", "description": "Per-command timeout fallback in ms"},
				"work_dir":   map[string]any{"type": "string", "description": "Default working directory (relative to sandbox workspace)"},
			},
			"required": []string{"commands"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params ExecBatchRequest
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		if len(params.Commands) == 0 {
			return &ToolResult{Success: false, Error: "commands must not be empty"}, nil
		}
		if len(params.Commands) > maxExecBatchCommands {
			return &ToolResult{Success: false, Error: fmt.Sprintf("commands exceeds max batch size %d", maxExecBatchCommands)}, nil
		}
		batchSandboxID := ctx.SnapshotSandboxID()
		if batchSandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}
		if ctx.ExecBus == nil || ctx.ExecCollector == nil {
			return &ToolResult{Success: false, Error: "parallel exec infrastructure not available"}, nil
		}

		start := time.Now()
		batchID := fmt.Sprintf("batch_%d", start.UnixNano())
		maxTimeoutMs := defaultExecBatchTimeoutMs

		done := ctx.ExecCollector.Submit(toolCtx, batchID, len(params.Commands), params.FailFast)
		for i := range params.Commands {
			cmd := params.Commands[i]
			cmd.Command = strings.TrimSpace(cmd.Command)
			if cmd.Command == "" {
				_ = ctx.ExecCollector.Abort(toolCtx, batchID, fmt.Sprintf("command %d is empty", i))
				return &ToolResult{Success: false, Error: fmt.Sprintf("command %d is empty", i)}, nil
			}
			if cmd.ID == "" {
				cmd.ID = fmt.Sprintf("%s:%d", batchID, i)
			}
			if cmd.TimeoutMs <= 0 {
				cmd.TimeoutMs = params.TimeoutMs
			}
			if cmd.TimeoutMs <= 0 {
				cmd.TimeoutMs = defaultExecBatchTimeoutMs
			}
			if cmd.TimeoutMs > maxExecBatchTimeoutMs {
				cmd.TimeoutMs = maxExecBatchTimeoutMs
			}
			if cmd.TimeoutMs > maxTimeoutMs {
				maxTimeoutMs = cmd.TimeoutMs
			}
			if cmd.WorkDir == "" {
				cmd.WorkDir = params.WorkDir
			}
			reuseCurrentSandbox := cmd.UseParentSandbox ||
				(cmd.SandboxHint == "" && cmd.PermissionProfile == "") ||
				cmd.SandboxHint == "inherit"
			sandboxID := ""
			if reuseCurrentSandbox {
				sandboxID = batchSandboxID
			}

			ctx.ExecBus.Publish(eventbus.EventExecRequested, map[string]any{
				"batch_id":           batchID,
				"id":                 cmd.ID,
				"index":              i,
				"command":            cmd.Command,
				"work_dir":           cmd.WorkDir,
				"env":                cmd.Env,
				"timeout_ms":         cmd.TimeoutMs,
				"sandbox_hint":       cmd.SandboxHint,
				"permission_profile": cmd.PermissionProfile,
				"use_parent_sandbox": cmd.UseParentSandbox,
				"sandbox_id":         sandboxID,
			})
		}

		waitCtx, cancel := context.WithTimeout(toolCtx, time.Duration(maxTimeoutMs+5_000)*time.Millisecond)
		defer cancel()
		select {
		case <-done:
		case <-waitCtx.Done():
			_ = ctx.ExecCollector.Abort(context.Background(), batchID, waitCtx.Err().Error())
			<-done
		}

		payload, err := ctx.ExecCollector.Result(batchID)
		if err != nil {
			return &ToolResult{Success: false, Error: err.Error()}, nil
		}

		results := make([]ExecResult, len(params.Commands))
		missing := false
		hasFailure := payload.Failed
		for i, cmd := range params.Commands {
			id := cmd.ID
			if id == "" {
				id = fmt.Sprintf("%s:%d", batchID, i)
			}
			r, ok := payload.Results[id]
			if !ok {
				missing = true
				hasFailure = true
				results[i] = ExecResult{
					BatchID: batchID,
					ID:      id,
					Index:   i,
					Status:  "missing",
					Error:   "result missing",
				}
				continue
			}
			if r.Status != "ok" {
				hasFailure = true
			}
			results[i] = ExecResult{
				BatchID:     r.BatchID,
				ID:          r.ID,
				Index:       r.Index,
				Status:      r.Status,
				ExitCode:    r.ExitCode,
				Stdout:      r.Stdout,
				Stderr:      r.Stderr,
				Duration:    r.Duration,
				DurationMs:  r.Duration.Milliseconds(),
				Error:       r.Error,
				SandboxID:   r.SandboxID,
				SandboxType: r.SandboxType,
				Truncated:   r.Truncated,
			}
		}

		status := "completed"
		if payload.Failed {
			status = "failed"
		} else if missing {
			status = "partial"
		} else if hasFailure {
			status = "failed"
		}

		result := ExecBatchResult{
			BatchID: batchID,
			Results: results,
			TotalMs: time.Since(start).Milliseconds(),
			Status:  status,
		}
		data, err := json.MarshalIndent(result, "", "  ")
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("marshal exec_batch result: %v", err)}, nil
		}
		slog.Info("exec_batch completed", "batch_id", batchID, "status", status, "commands", len(results), "duration_ms", result.TotalMs)
		return &ToolResult{Success: !hasFailure, Data: string(data)}, nil
	})
}
