package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/clawless/agentd/internal/clawless"
)

// subagentRegistry tracks running sub-agents.
var subagentRegistry = struct {
	mu       sync.RWMutex
	agents   map[string]*clawless.Task
	results  map[string]string
	summaries map[string]string
}{
	agents:    make(map[string]*clawless.Task),
	results:   make(map[string]string),
	summaries: make(map[string]string),
}

// SubagentSystemPrompt is the system prompt for sub-agents.
// Borrowed from Edelweiss's subagent-system.velin.md design:
// - No group chat / platform / end-user concepts
// - Task-focused: only assigned task + relevant context + expected output
// - Self-terminating: subagent must call finalize when done
const SubagentSystemPrompt = `You are an internal helper agent working on one assigned task from a parent agent.

## Assigned Task
{{task}}

## Context (relevant memory fragments and file boundaries)
{{context}}

## Rules
- Work ONLY on the assigned task. Do not deviate.
- You do NOT have access to the main conversation history. Only the context above is relevant.
- Do NOT mention or assume any external conversation, chat platform, channel, or end-user.
- When complete, your final response should be a concise summary of findings/results.
- Keep your final response under 500 words. Focus on: what was done, what was found, any errors/solutions.
- Use available tools (bash, file read/write, web search) as needed.`

// registerSubagent creates the subagent tool.
func registerSubagent(registry *ToolRegistry, client *clawless.Client, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "subagent",
		Description: "Create an isolated sub-agent to handle a task in parallel. The sub-agent gets its own sandbox and ONLY receives the task description + relevant context — NOT the full conversation history. Returns a subagent ID for checking results later. Before creating, infer file_boundaries — two sub-agents modifying the same file should run serially.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"task": map[string]any{
					"type":        "string",
					"description": "Concrete, self-contained task for the sub-agent",
				},
				"context": map[string]any{
					"type":        "string",
					"description": "Relevant memory fragments and file boundaries for this sub-task. Only include what the sub-agent needs — NOT the full conversation history.",
				},
				"expected_output": map[string]any{
					"type":        "string",
					"description": "The desired shape of the result (e.g., 'list of file paths', 'JSON config', 'summary of findings')",
				},
				"sandbox_type": map[string]any{
					"type":        "string",
					"description": "Sandbox type (tmpfs/chroot/docker). Default: tmpfs",
					"default":     "tmpfs",
				},
				"file_boundaries": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "string"},
					"description": "File path patterns this sub-agent is allowed to modify (glob syntax). Boundaries are enforced by L0.",
				},
			},
			"required": []string{"task"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Task           string   `json:"task"`
			Context        string   `json:"context"`
			ExpectedOutput string   `json:"expected_output"`
			SandboxType    string   `json:"sandbox_type"`
			FileBoundaries []string `json:"file_boundaries"`
		}
		if err := json.Unmarshal(args, &params); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("parse args: %v", err)}, nil
		}
		if params.SandboxType == "" {
			params.SandboxType = "tmpfs"
		}

		// Build isolated system prompt — no conversation history injected
		sysPrompt := strings.ReplaceAll(SubagentSystemPrompt, "{{task}}", params.Task)
		sysPrompt = strings.ReplaceAll(sysPrompt, "{{context}}", params.Context)

		subTask := &clawless.Task{
			AgentID:     ctx.AgentID,
			SessionID:   ctx.SessionID,
			Command:     params.Task,
			SandboxType: params.SandboxType,
			SystemPrompt: sysPrompt,
		}

		subagentRegistry.mu.Lock()
		subagentRegistry.agents[subTask.ID] = subTask
		subagentRegistry.mu.Unlock()

		boundaryInfo := "none"
		if len(params.FileBoundaries) > 0 {
			boundaryInfo = fmt.Sprintf("%v", params.FileBoundaries)
		}

		slog.Info("subagent created",
			"subagent_id", subTask.ID,
			"task", params.Task,
			"file_boundaries", boundaryInfo,
			"isolated", true,
		)

		return &ToolResult{
			Success: true,
			Data: fmt.Sprintf(
				"Sub-agent created (isolated context).\nID: %s\nTask: %s\nSandbox: %s\nFile boundaries: %s\nUse subagent_result to check the result.",
				subTask.ID, params.Task, params.SandboxType, boundaryInfo,
			),
		}, nil
	})
}

// registerSubagentResult creates the subagent_result tool with LLM summarization.
func registerSubagentResult(registry *ToolRegistry, client *clawless.Client, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "subagent_result",
		Description: "Check the result of a previously created sub-agent by its ID. Returns a concise summary (not the full raw output) to avoid bloating the main context.",
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
		summary, hasSummary := subagentRegistry.summaries[params.SubagentID]
		subagentRegistry.mu.RUnlock()

		if !exists {
			return &ToolResult{Success: false, Error: fmt.Sprintf("subagent %s not found", params.SubagentID)}, nil
		}

		if hasResult {
			// Return summary if available, otherwise return raw result
			output := result
			if hasSummary {
				output = summary
			}

			// Store summary in TaskState for context persistence
			ctx.TaskState.SubAgentSummaries = append(ctx.TaskState.SubAgentSummaries, SubAgentSummary{
				ID:        params.SubagentID,
				Task:      task.Command,
				Summary:   output,
				Success:   true,
				CreatedAt: time.Now().UTC().Format(time.RFC3339),
			})

			return &ToolResult{
				Success: true,
				Data:    fmt.Sprintf("Sub-agent %s completed.\nSummary:\n%s", params.SubagentID, output),
			}, nil
		}

		return &ToolResult{
			Success: true,
			Data:    fmt.Sprintf("Sub-agent %s is still running. Status: %s", params.SubagentID, task.Status),
		}, nil
	})
}

// SummarizeSubagentResult uses LLM to create a concise summary of a sub-agent's raw output.
// Called by the dispatcher after a sub-agent completes.
func SummarizeSubagentResult(ctx context.Context, client *clawless.Client, model, subagentID, task, rawResult string) (string, error) {
	prompt := fmt.Sprintf(`Summarize the following sub-agent result concisely (under 500 words).
Focus on: what was done, what was found, key file paths/artifacts, any errors and solutions.

Sub-agent task: %s

Raw result:
%s

Concise summary:`, task, truncate(rawResult, 3000))

	req := clawless.LLMProxyRequest{
		Model: model,
		Messages: []clawless.Message{
			{Role: "system", Content: "You summarize sub-agent results concisely. Output only the summary."},
			{Role: "user", Content: prompt},
		},
		Stream: false,
	}

	respData, err := client.LLMProxyRequest(ctx, &req)
	if err != nil {
		slog.Warn("subagent summary failed, using raw result", "subagent_id", subagentID, "error", err)
		return truncate(rawResult, 1000), nil // fallback to truncated raw
	}

	return string(respData), nil
}

// StoreSubagentResult stores the raw result and its summary in the registry.
func StoreSubagentResult(subagentID, rawResult, summary string) {
	subagentRegistry.mu.Lock()
	defer subagentRegistry.mu.Unlock()
	subagentRegistry.results[subagentID] = rawResult
	subagentRegistry.summaries[subagentID] = summary
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
