package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"

	"github.com/clawless/agentd/internal/clawless"
)

// subagentRegistry tracks running sub-agents.
var subagentRegistry = struct {
	mu       sync.RWMutex
	agents   map[string]*clawless.Task
	results  map[string]string
}{
	agents:  make(map[string]*clawless.Task),
	results: make(map[string]string),
}

func registerSubagent(registry *ToolRegistry, client *clawless.Client, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "subagent",
		Description: "Create a sub-agent to handle a task in parallel. The sub-agent gets its own sandbox and context. Returns a subagent ID for checking results later.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"task":         map[string]any{"type": "string", "description": "Task description for the sub-agent"},
				"sandbox_type": map[string]any{"type": "string", "description": "Sandbox type (tmpfs/chroot/docker). Default: tmpfs", "default": "tmpfs"},
			},
			"required": []string{"task"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Task        string `json:"task"`
			SandboxType string `json:"sandbox_type"`
		}
		if err := json.Unmarshal(args, &params); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("parse args: %v", err)}, nil
		}
		if params.SandboxType == "" {
			params.SandboxType = "tmpfs"
		}

		// Create a task for the sub-agent via ClawLess
		subTask := &clawless.Task{
			AgentID:     ctx.AgentID,
			SessionID:   ctx.SessionID,
			Command:     params.Task,
			SandboxType: params.SandboxType,
		}

		subagentRegistry.mu.Lock()
		subagentRegistry.agents[subTask.ID] = subTask
		subagentRegistry.mu.Unlock()

		slog.Info("subagent created", "subagent_id", subTask.ID, "task", params.Task)

		return &ToolResult{
			Success: true,
			Data:    fmt.Sprintf("Sub-agent created. ID: %s\nTask: %s\nSandbox: %s\nUse subagent_result to check the result.", subTask.ID, params.Task, params.SandboxType),
		}, nil
	})
}

func registerSubagentResult(registry *ToolRegistry, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "subagent_result",
		Description: "Check the result of a previously created sub-agent by its ID.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"subagent_id": map[string]any{"type": "string", "description": "Sub-agent ID returned by the subagent tool"},
			},
			"required": []string{"subagent_id"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			SubagentID string `json:"subagent_id"`
		}
		if err := json.Unmarshal(args, &params); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("parse args: %v", err)}, nil
		}

		subagentRegistry.mu.RLock()
		task, exists := subagentRegistry.agents[params.SubagentID]
		result, hasResult := subagentRegistry.results[params.SubagentID]
		subagentRegistry.mu.RUnlock()

		if !exists {
			return &ToolResult{Success: false, Error: fmt.Sprintf("subagent %s not found", params.SubagentID)}, nil
		}

		if hasResult {
			return &ToolResult{Success: true, Data: fmt.Sprintf("Sub-agent %s completed.\nResult:\n%s", params.SubagentID, result)}, nil
		}

		return &ToolResult{
			Success: true,
			Data:    fmt.Sprintf("Sub-agent %s is still running. Status: %s", params.SubagentID, task.Status),
		}, nil
	})
}
