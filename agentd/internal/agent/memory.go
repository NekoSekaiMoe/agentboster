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

// MemoryExtractPrompt extracts structured facts from a completed task conversation.
// Borrowed from Memoh's memory_extract.md design: two-stage pipeline with
// explicit categorization, negative examples, and language preservation.
const MemoryExtractPrompt = `You are a Personal Information Organizer. Given the conversation and result of a completed task, extract key facts that should be remembered for future sessions.

## Categories to extract (only if present in the conversation):

1. **Project Configuration** — project structure, build tools, dependencies, environment setup
2. **Technical Decisions** — chosen frameworks, libraries, patterns, and the reasons behind them
3. **File Paths & Artifacts** — important file paths, generated outputs, modified files
4. **Errors & Solutions** — errors encountered and how they were resolved
5. **User Preferences** — coding style, naming conventions, workflow preferences
6. **Recurring Patterns** — conventions, repeated commands, standard procedures
7. **Pending Items** — TODOs, blocked tasks, follow-up actions mentioned

## Important rules:
- Do NOT extract greetings, pleasantries, or trivial exchanges
- Do NOT extract general knowledge (e.g., "Git is a version control system")
- Do NOT extract temporary context that is only relevant to the current session
- Record all facts in English regardless of the conversation language
- If no meaningful facts exist, return an empty array

## Memory Extraction Rules

Before extracting, determine whether the completed work was a short task or a long-running task:

### Short tasks (single session, no task_summary record)
Extract key facts as listed in the categories above: project config, user preferences, technical decisions, errors & solutions.

### Long-running tasks (spans multiple sessions, has a task_summary record)
DO NOT extract individual facts. Instead, update the task summary through the task summary API/tool lifecycle:
- Update progress based on what was accomplished this session
- Append new decisions to the decision history
- Update pending items: add new ones and remove completed ones
- Update known issues: add new ones and mark resolved ones

Return an empty array for long-running tasks. Do not create a separate memory entry just to say the summary was updated.

The task summary is the single source of truth for long-running tasks. Individual memory entries are for cross-task reference; the summary is for continuing the same task.

## Output format (JSON only):
[
  {"key": "<category.short_name>", "value": "<fact description>"}
]

Examples:
- Conversation: "Hi!" → []
- Conversation: "There are branches in trees." → []
- Conversation: "User asked to use pnpm instead of npm for the monorepo" → [{"key": "pref.package_manager", "value": "User prefers pnpm over npm for monorepo projects"}]
- Conversation: "Fixed ECONNREFUSED by changing port from 3000 to 3001" → [{"key": "error.econnrefused", "value": "Port 3000 was occupied; resolved by switching to port 3001"}]

Task: {{task}}
Result: {{result}}

Return only the JSON array, nothing else.`

// MemoryUpdatePrompt reconciles newly extracted facts against existing memories.
// Borrowed from Memoh's memory_update.md: ADD / UPDATE / DELETE / NONE operations.
const MemoryUpdatePrompt = `You are a Memory Manager. Given existing memories and newly extracted facts, decide what to do with each new fact.

## Operations:
- **ADD**: New information not present in existing memories
- **UPDATE**: Same topic but with more detail or correction — keep the richer version
- **DELETE**: Contradicts an existing memory — remove the old one
- **NONE**: Already present, no change needed

## Rules:
- If two facts convey the same information at the same level of detail, use NONE
- If a new fact adds detail to an existing memory, use UPDATE and keep the richer version
- If a new fact contradicts an existing memory, use DELETE for the old and ADD for the new
- Do not create near-duplicate memories

## Output format (JSON only):
{"memory": [{"event": "ADD", "text": "<fact>"}, {"event": "UPDATE", "id": "<existing_id>", "text": "<new_text>", "old_memory": "<old_text>"}, {"event": "DELETE", "id": "<existing_id>"}, {"event": "NONE", "id": "<existing_id>"}]}

Existing memories:
{{existing_memories}}

New facts:
{{new_facts}}

Return only the JSON object, nothing else.`

// Fact represents an extracted key-value fact from a completed task.
type Fact struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// MemoryExtractor extracts structured memories from completed tasks.
type MemoryExtractor struct {
	clawless    *clawless.Client
	agentID     string
	llmEndpoint string
	llmModel    string
}

// NewMemoryExtractor creates a new memory extractor.
func NewMemoryExtractor(client *clawless.Client, agentID, llmEndpoint, llmModel string) *MemoryExtractor {
	return &MemoryExtractor{
		clawless:    client,
		agentID:     agentID,
		llmEndpoint: llmEndpoint,
		llmModel:    llmModel,
	}
}

// Extract analyzes a completed task and writes memories to ClawLess.
// Two-stage pipeline: Extract facts → Reconcile against existing → Apply.
func (e *MemoryExtractor) Extract(ctx context.Context, task *clawless.Task) error {
	if task.Result == "" {
		slog.Info("memory extraction: no result to extract", "task_id", task.ID)
		return nil
	}

	// Stage 1: Extract raw facts from the task
	facts, err := e.extractFacts(ctx, task)
	if err != nil {
		return fmt.Errorf("extract facts: %w", err)
	}
	if len(facts) == 0 {
		slog.Info("memory extraction: no facts extracted", "task_id", task.ID)
		return nil
	}

	// Stage 2: Reconcile against existing memories and apply
	if err := e.reconcileAndApply(ctx, facts, task); err != nil {
		return fmt.Errorf("reconcile memories: %w", err)
	}

	slog.Info("memory extraction: completed", "task_id", task.ID, "facts", len(facts))
	return nil
}

func (e *MemoryExtractor) extractFacts(ctx context.Context, task *clawless.Task) ([]Fact, error) {
	prompt := strings.ReplaceAll(MemoryExtractPrompt, "{{task}}", task.Command)
	prompt = strings.ReplaceAll(prompt, "{{result}}", truncate(task.Result, 2000))

	req := clawless.LLMProxyRequest{
		Model: e.llmModel,
		Messages: []clawless.Message{
			{Role: "system", Content: "You extract structured facts. Respond only with JSON."},
			{Role: "user", Content: prompt},
		},
		Stream: false,
	}

	respData, err := e.clawless.LLMProxyRequest(ctx, &req)
	if err != nil {
		return nil, fmt.Errorf("LLM proxy request: %w", err)
	}

	return parseFacts(respData)
}

func (e *MemoryExtractor) reconcileAndApply(ctx context.Context, facts []Fact, task *clawless.Task) error {
	// Fetch existing memories for this agent
	existing, err := e.clawless.ListMemories(ctx, e.agentID)
	if err != nil {
		slog.Warn("memory extraction: failed to list existing memories, writing all as new", "error", err)
		// Fallback: write all facts as new
		return e.writeNewMemories(ctx, facts, task)
	}

	// Build the reconciliation prompt
	existingText := formatExistingMemories(existing)
	factsText := formatNewFacts(facts)

	prompt := strings.ReplaceAll(MemoryUpdatePrompt, "{{existing_memories}}", existingText)
	prompt = strings.ReplaceAll(prompt, "{{new_facts}}", factsText)

	req := clawless.LLMProxyRequest{
		Model: e.llmModel,
		Messages: []clawless.Message{
			{Role: "system", Content: "You manage memory deduplication. Respond only with JSON."},
			{Role: "user", Content: prompt},
		},
		Stream: false,
	}

	respData, err := e.clawless.LLMProxyRequest(ctx, &req)
	if err != nil {
		slog.Warn("memory extraction: reconciliation failed, writing all as new", "error", err)
		return e.writeNewMemories(ctx, facts, task)
	}

	return e.applyReconciliation(ctx, respData, existing, task)
}

func (e *MemoryExtractor) applyReconciliation(ctx context.Context, respData []byte, existing []clawless.Memory, task *clawless.Task) error {
	var result struct {
		Memory []struct {
			Event     string `json:"event"`
			ID        string `json:"id"`
			Text      string `json:"text"`
			OldMemory string `json:"old_memory"`
		} `json:"memory"`
	}

	text := string(respData)
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start >= 0 && end > start {
		if err := json.Unmarshal([]byte(text[start:end+1]), &result); err != nil {
			slog.Warn("memory extraction: failed to parse reconciliation, writing all as new", "error", err)
			return nil
		}
	}

	for _, op := range result.Memory {
		switch op.Event {
		case "ADD":
			mem := clawless.Memory{
				AgentID:   e.agentID,
				Key:       "extracted",
				Value:     op.Text,
				Source:    task.SessionID,
				CreatedAt: time.Now(),
			}
			if err := e.clawless.WriteMemories(ctx, []clawless.Memory{mem}); err != nil {
				slog.Warn("memory extraction: failed to write memory", "error", err)
			}
		case "UPDATE":
			if op.ID != "" {
				if err := e.clawless.UpdateMemory(ctx, op.ID, op.Text); err != nil {
					slog.Warn("memory extraction: failed to update memory", "id", op.ID, "error", err)
				}
			}
		case "DELETE":
			if op.ID != "" {
				if err := e.clawless.DeleteMemory(ctx, op.ID); err != nil {
					slog.Warn("memory extraction: failed to delete memory", "id", op.ID, "error", err)
				}
			}
		case "NONE":
			// No action needed
		}
	}

	return nil
}

func (e *MemoryExtractor) writeNewMemories(ctx context.Context, facts []Fact, task *clawless.Task) error {
	memories := make([]clawless.Memory, len(facts))
	for i, f := range facts {
		memories[i] = clawless.Memory{
			AgentID:   e.agentID,
			Key:       f.Key,
			Value:     f.Value,
			Source:    task.SessionID,
			CreatedAt: time.Now(),
		}
	}
	return e.clawless.WriteMemories(ctx, memories)
}

func parseFacts(respData []byte) ([]Fact, error) {
	var facts []Fact

	text := string(respData)

	// Try direct JSON parse
	if err := json.Unmarshal(respData, &facts); err == nil {
		return facts, nil
	}

	// Try to extract JSON array from response
	start := strings.Index(text, "[")
	end := strings.LastIndex(text, "]")
	if start >= 0 && end > start {
		if err := json.Unmarshal([]byte(text[start:end+1]), &facts); err == nil {
			return facts, nil
		}
	}

	return nil, fmt.Errorf("no JSON array found in response")
}

func formatExistingMemories(memories []clawless.Memory) string {
	if len(memories) == 0 {
		return "(none)"
	}
	var sb strings.Builder
	for _, m := range memories {
		sb.WriteString(fmt.Sprintf("- [%s] %s: %s\n", m.ID, m.Key, m.Value))
	}
	return sb.String()
}

func formatNewFacts(facts []Fact) string {
	var sb strings.Builder
	for _, f := range facts {
		sb.WriteString(fmt.Sprintf("- %s: %s\n", f.Key, f.Value))
	}
	return sb.String()
}
