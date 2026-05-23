package agent

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/clawless/agentd/internal/sandbox"
)

func registerGitClone(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "git_clone",
		Description: "Clone a git repository into the sandbox workspace.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"url":      map[string]any{"type": "string", "description": "Git repository URL"},
				"branch":   map[string]any{"type": "string", "description": "Branch to checkout (optional)"},
				"depth":    map[string]any{"type": "integer", "description": "Shallow clone depth (optional)"},
			},
			"required": []string{"url"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			URL    string `json:"url"`
			Branch string `json:"branch"`
			Depth  int    `json:"depth"`
		}
		if err := json.Unmarshal(args, &params); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("parse args: %v", err)}, nil
		}

		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		cmd := fmt.Sprintf("git clone")
		if params.Depth > 0 {
			cmd += fmt.Sprintf(" --depth %d", params.Depth)
		}
		if params.Branch != "" {
			cmd += fmt.Sprintf(" --branch %s", params.Branch)
		}
		cmd += fmt.Sprintf(" %s repo", params.URL)

		result, err := sbMgr.Exec(sandboxID, cmd, nil, 120)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("git clone error: %v", err)}, nil
		}

		return &ToolResult{Success: result.ExitCode == 0, Data: result.Stdout, Error: result.Stderr}, nil
	})
}

func registerGitDiff(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "git_diff",
		Description: "Show git diff in the sandbox workspace.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{"type": "string", "description": "Path to git repo (relative to workspace)", "default": "."},
			},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(args, &params); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("parse args: %v", err)}, nil
		}

		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		cmd := fmt.Sprintf("cd %s && git diff", params.Path)
		result, err := sbMgr.Exec(sandboxID, cmd, nil, 30)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("git diff error: %v", err)}, nil
		}

		return &ToolResult{Success: true, Data: result.Stdout}, nil
	})
}

func registerGitStatus(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "git_status",
		Description: "Show git status in the sandbox workspace.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{"type": "string", "description": "Path to git repo (relative to workspace)", "default": "."},
			},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(args, &params); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("parse args: %v", err)}, nil
		}

		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		cmd := fmt.Sprintf("cd %s && git status", params.Path)
		result, err := sbMgr.Exec(sandboxID, cmd, nil, 15)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("git status error: %v", err)}, nil
		}

		return &ToolResult{Success: true, Data: result.Stdout}, nil
	})
}
