package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/clawless/agentd/internal/sandbox"
)

func registerExec(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "exec",
		Description: "Execute a shell command in the sandbox. Returns stdout, stderr, and exit code.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"command":      map[string]any{"type": "string", "description": "Shell command to execute"},
				"timeout":      map[string]any{"type": "integer", "description": "Timeout in seconds (default 60)", "default": 60},
				"working_dir":  map[string]any{"type": "string", "description": "Working directory (relative to sandbox workspace)", "default": "."},
			},
			"required": []string{"command"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Command    string `json:"command"`
			Timeout    int    `json:"timeout"`
			WorkingDir string `json:"working_dir"`
		}
		if err := json.Unmarshal(args, &params); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("parse args: %v", err)}, nil
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
	registry.Register(ToolDefinition{
		Name:        "exec_background",
		Description: "Start a long-running command in the background. Returns a process ID for later status check.",
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
		if err := json.Unmarshal(args, &params); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("parse args: %v", err)}, nil
		}

		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		// Wrap in nohup + background
		bgCmd := fmt.Sprintf("nohup bash -c %q > /tmp/agentd-bg.log 2>&1 & echo $!", params.Command)
		result, err := sbMgr.Exec(sandboxID, bgCmd, nil, 10)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("exec error: %v", err)}, nil
		}

		return &ToolResult{Success: true, Data: fmt.Sprintf("Started in background. PID: %s\nLog: /tmp/agentd-bg.log", result.Stdout)}, nil
	})
}
