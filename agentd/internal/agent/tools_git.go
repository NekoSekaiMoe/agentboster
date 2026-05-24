package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"

	"github.com/clawless/agentd/internal/sandbox"
)

// safeShellArg matches characters that are safe to pass as shell arguments.
var safeShellArg = regexp.MustCompile(`^[a-zA-Z0-9_./:@=+,-]+$`)

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

		if !safeShellArg.MatchString(params.URL) {
			return &ToolResult{Success: false, Error: "invalid characters in git URL"}, nil
		}

		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		cmd := "git clone"
		if params.Depth > 0 {
			cmd += fmt.Sprintf(" --depth %d", params.Depth)
		}
		if params.Branch != "" {
			if !safeShellArg.MatchString(params.Branch) {
				return &ToolResult{Success: false, Error: "invalid characters in branch name"}, nil
			}
			cmd += fmt.Sprintf(" --branch %s", params.Branch)
		}
		cmd += fmt.Sprintf(" %q repo", params.URL)

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

		if !safeShellArg.MatchString(params.Path) {
			return &ToolResult{Success: false, Error: "invalid characters in path"}, nil
		}

		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		cmd := fmt.Sprintf("cd %q && git diff", params.Path)
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

		if !safeShellArg.MatchString(params.Path) {
			return &ToolResult{Success: false, Error: "invalid characters in path"}, nil
		}

		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		cmd := fmt.Sprintf("cd %q && git status", params.Path)
		result, err := sbMgr.Exec(sandboxID, cmd, nil, 15)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("git status error: %v", err)}, nil
		}

		return &ToolResult{Success: true, Data: result.Stdout}, nil
	})
}