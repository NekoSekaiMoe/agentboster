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

// MemoryExtractionPrompt is used to extract structured facts from a completed task.
const MemoryExtractionPrompt = `You are a memory extraction assistant. Given a completed task, extract key facts that should be remembered for future sessions.

Task: {{task}}
Result: {{result}}

Extract structured facts as a JSON array of objects with "key" and "value" fields.
Focus on:
- Project configurations discovered
- User preferences mentioned
- Important file paths or dependencies
- Recurring patterns or conventions
- Any errors encountered and their solutions

Return only the JSON array, nothing else.`

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
func (e *MemoryExtractor) Extract(ctx context.Context, task *clawless.Task) error {
	if task.Result == "" {
		slog.Info("memory extraction: no result to extract", "task_id", task.ID)
		return nil
	}

	prompt := strings.ReplaceAll(MemoryExtractionPrompt, "{{task}}", task.Command)
	prompt = strings.ReplaceAll(prompt, "{{result}}", truncate(task.Result, 2000))

	// Call LLM to extract memories
	req := clawless.LLMProxyRequest{
		Model: e.llmModel,
		Messages: []clawless.Message{
			{Role: "system", Content: "You extract structured facts. Respond only with JSON."},
			{Role: "user", Content: prompt},
		},
		Stream: false,
	}

	data, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("marshal request: %w", err)
	}
	_ = data

	respData, err := e.clawless.LLMProxyRequest(ctx, &req)
	if err != nil {
		return fmt.Errorf("LLM proxy request: %w", err)
	}

	// Parse extracted facts
	var facts []struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}

	if err := json.Unmarshal(respData, &facts); err != nil {
		// Try to extract JSON array from response
		text := string(respData)
		start := strings.Index(text, "[")
		end := strings.LastIndex(text, "]")
		if start >= 0 && end > start {
			if err := json.Unmarshal([]byte(text[start:end+1]), &facts); err != nil {
				slog.Warn("memory extraction: failed to parse facts", "error", err)
				return nil // non-fatal
			}
		} else {
			return nil // non-fatal
		}
	}

	if len(facts) == 0 {
		return nil
	}

	// Write memories
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

	if err := e.clawless.WriteMemories(ctx, memories); err != nil {
		return fmt.Errorf("write memories: %w", err)
	}

	slog.Info("memory extraction: wrote memories", "task_id", task.ID, "count", len(memories))
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
