package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/sandbox"
)

// subagentRegistry tracks running sub-agents.
var subagentRegistry = struct {
	mu        sync.RWMutex
	agents    map[string]*clawless.Task
	results   map[string]string
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
				"resume_from": map[string]any{
					"type":        "string",
					"description": "Sub-agent ID to resume from a previous crashed session. Loads state from workspace/sessions/subagent_{id}.json.",
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
			ResumeFrom     string   `json:"resume_from"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		if params.SandboxType == "" {
			params.SandboxType = "tmpfs"
		}

		// Build isolated system prompt — no conversation history injected
		sysPrompt := strings.ReplaceAll(SubagentSystemPrompt, "{{task}}", params.Task)
		sysPrompt = strings.ReplaceAll(sysPrompt, "{{context}}", params.Context)

		// Handle resume from state
		var resumeState *SubagentResumeState
		if params.ResumeFrom != "" {
			resumeState = loadSubagentResumeState(ctx.SandboxPath, params.ResumeFrom)
		}

		subTask := &clawless.Task{
			AgentID:      ctx.AgentID,
			SessionID:    ctx.SessionID,
			Command:      params.Task,
			SandboxType:  params.SandboxType,
			SystemPrompt: sysPrompt,
		}

		subagentRegistry.mu.Lock()
		subagentRegistry.agents[subTask.ID] = subTask
		subagentRegistry.mu.Unlock()

		// Save initial state for crash recovery
		statePath := saveSubagentState(ctx.SandboxPath, subTask.ID, params.Task, params.Context, ctx.SessionID, ctx.SandboxID, ctx.SandboxType)

		// Track state file in TaskState for persistence across compaction
		if ctx.TaskState.SubAgentStates == nil {
			ctx.TaskState.SubAgentStates = make(map[string]string)
		}
		ctx.TaskState.SubAgentStates[subTask.ID] = statePath

		boundaryInfo := "none"
		if len(params.FileBoundaries) > 0 {
			boundaryInfo = fmt.Sprintf("%v", params.FileBoundaries)
		}

		resumeInfo := ""
		if resumeState != nil {
			resumeInfo = fmt.Sprintf("\nResumed from: %s (step %d)", params.ResumeFrom, resumeState.Step)
		}

		slog.Info("subagent created",
			"subagent_id", subTask.ID,
			"task", params.Task,
			"file_boundaries", boundaryInfo,
			"isolated", true,
			"state_path", statePath,
			"resumed", resumeState != nil,
		)

		return &ToolResult{
			Success: true,
			Data: fmt.Sprintf(
				"Sub-agent created (isolated context).\nID: %s\nTask: %s\nSandbox: %s\nFile boundaries: %s\nState: %s%s\nUse subagent_result to check the result.\nTo resume after crash: subagent(resume_from=%s, task=<original task>)",
				subTask.ID, params.Task, params.SandboxType, boundaryInfo, statePath, resumeInfo, subTask.ID,
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
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
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

			// Update state file to completed
			statePath := ""
			if ctx.SandboxPath != "" {
				updateSubagentState(ctx.SandboxPath, params.SubagentID, 0, "completed")
				statePath = filepath.Join(ctx.SandboxPath, "workspace", "sessions", fmt.Sprintf("subagent_%s.json", params.SubagentID))
			}

			stateInfo := ""
			if statePath != "" {
				stateInfo = fmt.Sprintf("\nState saved: %s", statePath)
			}

			return &ToolResult{
				Success: true,
				Data:    fmt.Sprintf("Sub-agent %s completed.\nSummary:\n%s%s", params.SubagentID, output, stateInfo),
			}, nil
		}

		// Check if sub-agent crashed — state file may still exist
		stateInfo := ""
		if ctx.SandboxPath != "" {
			resumeState := loadSubagentResumeState(ctx.SandboxPath, params.SubagentID)
			if resumeState != nil && resumeState.Status == "running" {
				stateInfo = fmt.Sprintf("\n\n⚠ Sub-agent appears to have crashed (state: running but no result).\nTo resume: subagent(resume_from=%s, task=%q)", params.SubagentID, task.Command)
			}
		}

		return &ToolResult{
			Success: true,
			Data:    fmt.Sprintf("Sub-agent %s is still running. Status: %s%s", params.SubagentID, task.Status, stateInfo),
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

// SubagentResumeState holds minimal state for resuming a crashed sub-agent.
type SubagentResumeState struct {
	ID              string `json:"id"`
	Task            string `json:"task"`
	Context         string `json:"context"`
	ParentSessionID string `json:"parent_session_id"`
	SandboxID       string `json:"sandbox_id"`
	SandboxType     string `json:"sandbox_type"`
	Step            int    `json:"step"`
	Status          string `json:"status"`
}

// saveSubagentState saves sub-agent state to workspace/sessions/subagent_{id}.json.
func saveSubagentState(sandboxPath, subagentID, task, context, parentSessionID, sandboxID, sandboxType string) string {
	if sandboxPath == "" {
		return ""
	}

	sessionsDir := filepath.Join(sandboxPath, "workspace", "sessions")
	os.MkdirAll(sessionsDir, 0o755)

	state := SubagentResumeState{
		ID:              subagentID,
		Task:            task,
		Context:         context,
		ParentSessionID: parentSessionID,
		SandboxID:       sandboxID,
		SandboxType:     sandboxType,
		Step:            0,
		Status:          "running",
	}

	path := filepath.Join(sessionsDir, fmt.Sprintf("subagent_%s.json", subagentID))
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		slog.Warn("failed to marshal subagent state", "error", err)
		return ""
	}

	if err := os.WriteFile(path, data, 0o640); err != nil {
		slog.Warn("failed to save subagent state", "error", err)
		return ""
	}

	return path
}

// loadSubagentResumeState loads a sub-agent's resume state from disk.
func loadSubagentResumeState(sandboxPath, subagentID string) *SubagentResumeState {
	if sandboxPath == "" || subagentID == "" {
		return nil
	}

	path := filepath.Join(sandboxPath, "workspace", "sessions", fmt.Sprintf("subagent_%s.json", subagentID))
	data, err := os.ReadFile(path)
	if err != nil {
		slog.Warn("failed to load subagent state", "subagent_id", subagentID, "error", err)
		return nil
	}

	var state SubagentResumeState
	if err := json.Unmarshal(data, &state); err != nil {
		slog.Warn("failed to unmarshal subagent state", "subagent_id", subagentID, "error", err)
		return nil
	}

	return &state
}

// updateSubagentState updates the step and status of a sub-agent state file.
func updateSubagentState(sandboxPath, subagentID string, step int, status string) {
	if sandboxPath == "" || subagentID == "" {
		return
	}

	path := filepath.Join(sandboxPath, "workspace", "sessions", fmt.Sprintf("subagent_%s.json", subagentID))
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}

	var state SubagentResumeState
	if err := json.Unmarshal(data, &state); err != nil {
		return
	}

	state.Step = step
	state.Status = status

	data, _ = json.MarshalIndent(state, "", "  ")
	os.WriteFile(path, data, 0o640)
}

var _ = sandbox.DiscoverSkills // ensure sandbox import is used
