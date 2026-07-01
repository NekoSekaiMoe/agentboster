package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
)

// registerSandboxDestroy exposes a `sandbox_destroy` tool to the LLM. The
// agent can use it when the user asks to "delete this project's container"
// or "clean up the sandbox". It calls DestroySandboxForce so the LXC rootfs
// is removed (not just stopped), matching the user's intent of "destroy".
//
// Restricted to trusted users because it is a destructive operation.
// The tool only destroys the *current session's* sandbox — the agent
// cannot reach into other sessions' containers.
//
// After destruction, AgentContext.SandboxID is cleared. The next exec /
// sandbox tool call will surface "no sandbox available"; the user must
// start a new session to get a fresh sandbox.
func registerSandboxDestroy(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "sandbox_destroy",
		Description: "Permanently destroy the sandbox container for the current session. Use only when the user explicitly asks to clean up / tear down / delete the project environment. For LXC sandboxes this removes the persistent rootfs (all files inside the container are lost). A new sandbox is NOT created automatically — the session will need a new task to spin one up.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"confirm": map[string]any{
					"type":        "boolean",
					"description": "Must be true to confirm destruction. Set to false or omit to cancel.",
					"default":     false,
				},
				"reason": map[string]any{
					"type":        "string",
					"description": "Short reason for destruction (recorded in the activity log).",
				},
			},
			"required": []string{"confirm"},
		},
		MinUserType: "trusted",
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Confirm bool   `json:"confirm"`
			Reason  string `json:"reason"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		if !params.Confirm {
			return &ToolResult{
				Success: true,
				Data:    "Destruction cancelled (confirm=false).",
			}, nil
		}

		sandboxID := ctx.SandboxID
		if sandboxID == "" {
			return &ToolResult{
				Success: false,
				Error:   "no active sandbox for this session",
			}, nil
		}

		sbType := ctx.SandboxType
		sbPath := ctx.SandboxPath

		if err := sbMgr.DestroySandboxForce(sandboxID); err != nil {
			slog.Warn("sandbox_destroy tool: destroy failed",
				"session_id", ctx.SessionID, "sandbox_id", sandboxID, "error", err)
			return &ToolResult{
				Success: false,
				Error:   fmt.Sprintf("destroy failed: %v", err),
			}, nil
		}

		// Clear the context so subsequent tool calls fail fast and the
		// next session creates a fresh sandbox instead of reusing the
		// dead ID.
		ctx.SandboxID = ""
		ctx.SandboxPath = ""
		ctx.SandboxState = SandboxInfo{}

		slog.Info("sandbox_destroy tool: destroyed",
			"session_id", ctx.SessionID,
			"sandbox_id", sandboxID,
			"type", sbType,
			"path", sbPath,
			"reason", params.Reason)

		return &ToolResult{
			Success: true,
			Data: fmt.Sprintf(
				"Sandbox %s (%s) destroyed. The session no longer has an active sandbox; subsequent sandbox tools will report 'no sandbox available' until a new task creates one.",
				sandboxID, sbType),
		}, nil
	})
}
