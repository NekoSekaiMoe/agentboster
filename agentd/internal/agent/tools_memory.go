package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/clawless/agentd/internal/clawless"
)

func registerMemorySearch(registry *ToolRegistry, client *clawless.Client, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "memory_search",
		Description: "Search agent memories by keywords. Returns relevant memory entries.",
		MinUserType: "unknown",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": map[string]any{"type": "string", "description": "Search query / keywords"},
				"limit": map[string]any{"type": "integer", "description": "Max results (default 5)", "default": 5},
			},
			"required": []string{"query"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		if params.Limit <= 0 {
			params.Limit = 5
		}

		memories, err := client.GetMemories(toolCtx, ctx.AgentID, []string{params.Query}, params.Limit, clawless.MemoryScope{
			TaskID:    ctx.TaskID,
			SessionID: ctx.SessionID,
		})
		if err != nil {
			slog.Warn("memory search failed", "error", err)
			return &ToolResult{Success: true, Data: "(no memories found)"}, nil
		}

		if len(memories) == 0 {
			return &ToolResult{Success: true, Data: "(no memories found)"}, nil
		}

		var result string
		for _, m := range memories {
			result += fmt.Sprintf("- [%s] %s\n", m.Key, m.Value)
		}
		return &ToolResult{Success: true, Data: result}, nil
	})
}

func registerMemorySave(registry *ToolRegistry, client *clawless.Client, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "memory_save",
		Description: "Save a memory entry for future reference.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"key":   map[string]any{"type": "string", "description": "Memory key / tag"},
				"value": map[string]any{"type": "string", "description": "Memory content"},
			},
			"required": []string{"key", "value"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Key   string `json:"key"`
			Value string `json:"value"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		memory := clawless.Memory{
			AgentID: ctx.AgentID,
			Key:     params.Key,
			Value:   params.Value,
			Source:  ctx.SessionID,
		}

		if err := client.WriteMemories(toolCtx, []clawless.Memory{memory}, clawless.MemoryScope{
			TaskID:    ctx.TaskID,
			SessionID: ctx.SessionID,
		}); err != nil {
			slog.Warn("memory save failed", "error", err)
			return &ToolResult{Success: false, Error: fmt.Sprintf("save memory: %v", err)}, nil
		}

		return &ToolResult{Success: true, Data: fmt.Sprintf("Memory saved: [%s] %s", params.Key, params.Value)}, nil
	})
}
