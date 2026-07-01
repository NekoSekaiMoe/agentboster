package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
)

func taskSummaryID(ctx *AgentContext) string {
	if strings.TrimSpace(ctx.TaskID) != "" {
		return ctx.TaskID
	}
	return ctx.SessionID
}

func registerTaskSummary(registry *ToolRegistry, client *clawless.Client, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "task_summary",
		Description: "View the current task summary. Returns progress, decisions, pending items, and known issues. Call this at the start of each session to understand where you left off.",
		Parameters: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		taskID := taskSummaryID(ctx)
		summary, err := client.GetTaskSummary(toolCtx, taskID)
		if err != nil {
			slog.Warn("task_summary: failed to fetch", "error", err)
			return &ToolResult{Success: true, Data: "(no task summary found — this may be a new or short-term task)"}, nil
		}

		data, _ := json.MarshalIndent(summary, "", "  ")
		return &ToolResult{Success: true, Data: string(data)}, nil
	})
}

func registerTaskProgress(registry *ToolRegistry, client *clawless.Client, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "task_progress",
		Description: "Update the task summary with progress, decisions, pending items, or known issues. Call this whenever you make a significant decision, complete a milestone, encounter a blocker, or resolve a known issue. The summary is your only memory across sessions — keep it current.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"progress": map[string]any{
					"type":        "string",
					"description": "Current progress description (free text). Overwrites the previous progress.",
				},
				"decision": map[string]any{
					"type":        "object",
					"description": "Record a significant decision. Include what you chose, why, and what alternatives you considered.",
					"properties": map[string]any{
						"description": map[string]any{"type": "string", "description": "What you chose / the decision made"},
						"reason":      map[string]any{"type": "string", "description": "Why you chose this approach"},
						"alternatives": map[string]any{
							"type":        "array",
							"items":       map[string]any{"type": "string"},
							"description": "Other approaches you considered and why you rejected them",
						},
					},
					"required": []string{"description", "reason"},
				},
				"pending_add": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "string"},
					"description": "Add new pending items (to-do tasks)",
				},
				"pending_done": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "string"},
					"description": "Mark pending items as done (by exact text match)",
				},
				"known_issue_add": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "string"},
					"description": "Add new known issues or blockers",
				},
				"known_issue_resolve": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "string"},
					"description": "Mark known issues as resolved (by exact text match)",
				},
			},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		if !json.Valid(args) {
			return &ToolResult{Success: false, Error: "parse args: invalid JSON"}, nil
		}

		taskID := taskSummaryID(ctx)
		summary, err := client.UpdateTaskProgress(toolCtx, taskID, args)
		if err != nil {
			slog.Warn("task_progress: failed to update", "error", err)
			return &ToolResult{Success: false, Error: fmt.Sprintf("update task summary: %v", err)}, nil
		}

		data, _ := json.MarshalIndent(summary, "", "  ")
		return &ToolResult{Success: true, Data: string(data)}, nil
	})
}
