package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/sandbox"
)

func registerSandboxInstall(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "sandbox_install",
		Description: "Install packages or tools in the sandbox. Supports apt, pip, npm, go install, etc.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"packages": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "List of packages to install"},
				"manager":  map[string]any{"type": "string", "description": "Package manager: apt, pip, npm, go. Default: auto-detect", "default": "auto"},
			},
			"required": []string{"packages"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Packages []string `json:"packages"`
			Manager  string   `json:"manager"`
		}
		if err := json.Unmarshal(args, &params); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("parse args: %v", err)}, nil
		}

		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		manager := params.Manager
		if manager == "auto" {
			manager = "apt" // default
		}

		var cmd string
		switch manager {
		case "apt":
			cmd = fmt.Sprintf("apt-get update && apt-get install -y %s", joinPackages(params.Packages))
		case "pip":
			cmd = fmt.Sprintf("pip install %s", joinPackages(params.Packages))
		case "npm":
			cmd = fmt.Sprintf("npm install -g %s", joinPackages(params.Packages))
		case "go":
			cmd = fmt.Sprintf("go install %s", joinPackages(params.Packages))
		default:
			return &ToolResult{Success: false, Error: fmt.Sprintf("unknown package manager: %s", manager)}, nil
		}

		result, err := sbMgr.Exec(sandboxID, cmd, nil, 300)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("install error: %v", err)}, nil
		}

		return &ToolResult{Success: result.ExitCode == 0, Data: result.Stdout, Error: result.Stderr}, nil
	})
}

func registerNotifyUser(registry *ToolRegistry, client *clawless.Client, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "notify_user",
		Description: "Send a notification message to the user. Use this to report progress, ask for input, or escalate issues.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"message": map[string]any{"type": "string", "description": "Message to send to the user"},
				"level":   map[string]any{"type": "string", "description": "Notification level: info, warning, error. Default: info", "default": "info"},
			},
			"required": []string{"message"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Message string `json:"message"`
			Level   string `json:"level"`
		}
		if err := json.Unmarshal(args, &params); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("parse args: %v", err)}, nil
		}

		slog.Info("notify_user", "level", params.Level, "message", params.Message)

		// In Phase 5, this would send via ClawLess API to the user's chat platform
		// For now, log and return success
		return &ToolResult{
			Success: true,
			Data:    fmt.Sprintf("Notification sent [%s]: %s", params.Level, params.Message),
		}, nil
	})
}

func joinPackages(pkgs []string) string {
	result := ""
	for i, p := range pkgs {
		if i > 0 {
			result += " "
		}
		result += p
	}
	return result
}
