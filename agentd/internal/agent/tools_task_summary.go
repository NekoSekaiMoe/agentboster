package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/clawless/agentd/internal/clawless"
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
		var params struct {
			Progress          *string  `json:"progress"`
			PendingAdd        []string `json:"pending_add"`
			PendingDone       []string `json:"pending_done"`
			KnownIssueAdd     []string `json:"known_issue_add"`
			KnownIssueResolve []string `json:"known_issue_resolve"`
			Decision          *struct {
				Description  string   `json:"description"`
				Reason       string   `json:"reason"`
				Alternatives []string `json:"alternatives"`
			} `json:"decision"`
		}
		if err := json.Unmarshal(args, &params); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("parse args: %v", err)}, nil
		}

		taskID := taskSummaryID(ctx)

		// Fetch existing summary to merge fields
		existing, err := client.GetTaskSummary(toolCtx, taskID)
		if err != nil {
			slog.Warn("task_progress: failed to fetch existing summary, creating new", "error", err)
		}

		update := clawless.TaskSummaryUpdate{}

		// Progress
		if params.Progress != nil {
			update.Progress = params.Progress
		}

		// Decisions: append new decision to existing list
		var decisions []clawless.Decision
		if existing != nil {
			decisions = existing.Decisions
		}
		if params.Decision != nil {
			decisions = append(decisions, clawless.Decision{
				ID:           fmt.Sprintf("dec_%d", time.Now().UnixNano()),
				Timestamp:    time.Now(),
				Description:  params.Decision.Description,
				Reason:       params.Decision.Reason,
				Alternatives: params.Decision.Alternatives,
			})
		}
		if len(decisions) > 0 {
			update.Decisions = decisions
		}

		// Pending: merge — add new ones, remove done ones
		var pending []string
		if existing != nil {
			pending = existing.Pending
		}
		for _, item := range params.PendingAdd {
			pending = append(pending, item)
		}
		if len(params.PendingDone) > 0 {
			doneSet := make(map[string]bool)
			for _, d := range params.PendingDone {
				doneSet[d] = true
			}
			filtered := make([]string, 0, len(pending))
			for _, p := range pending {
				if !doneSet[p] {
					filtered = append(filtered, p)
				}
			}
			pending = filtered
		}
		update.Pending = pending

		// Known issues: merge — add new ones, remove resolved ones
		var knownIssues []string
		if existing != nil {
			knownIssues = existing.KnownIssues
		}
		for _, item := range params.KnownIssueAdd {
			knownIssues = append(knownIssues, item)
		}
		if len(params.KnownIssueResolve) > 0 {
			resolvedSet := make(map[string]bool)
			for _, r := range params.KnownIssueResolve {
				resolvedSet[r] = true
			}
			filtered := make([]string, 0, len(knownIssues))
			for _, ki := range knownIssues {
				if !resolvedSet[ki] {
					filtered = append(filtered, ki)
				}
			}
			knownIssues = filtered
		}
		update.KnownIssues = knownIssues

		summary, err := client.UpdateTaskSummary(toolCtx, taskID, update)
		if err != nil {
			slog.Warn("task_progress: failed to update", "error", err)
			return &ToolResult{Success: false, Error: fmt.Sprintf("update task summary: %v", err)}, nil
		}

		data, _ := json.MarshalIndent(summary, "", "  ")
		return &ToolResult{Success: true, Data: string(data)}, nil
	})
}
