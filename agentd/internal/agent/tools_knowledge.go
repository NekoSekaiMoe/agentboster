package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"github.com/clawless/agentd/internal/clawless"
)

func truncateKnowledgeContent(content string, maxRunes int) string {
	runes := []rune(content)
	if len(runes) <= maxRunes {
		return content
	}
	return string(runes[:maxRunes]) + "..."
}

func registerKnowledgeSearch(registry *ToolRegistry, client *clawless.Client, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "knowledge_search",
		Description: "Search AgentBoster knowledge bases for uploaded documents, project references, policies, or domain knowledge. Use memory_search for user preferences and historical facts.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": map[string]any{"type": "string", "description": "Search query"},
				"knowledge_base_names": map[string]any{
					"type":        "array",
					"description": "Optional knowledge base names to search. Omit to search all visible knowledge bases.",
					"items":       map[string]any{"type": "string"},
				},
				"knowledge_base_ids": map[string]any{
					"type":        "array",
					"description": "Optional knowledge base IDs to search. Omit to search all visible knowledge bases.",
					"items":       map[string]any{"type": "string"},
				},
				"limit": map[string]any{"type": "integer", "description": "Max results (default 5, max 20)", "default": 5},
			},
			"required": []string{"query"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Query              string   `json:"query"`
			KnowledgeBaseNames []string `json:"knowledge_base_names"`
			KnowledgeBaseIDs   []string `json:"knowledge_base_ids"`
			Limit              int      `json:"limit"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		params.Query = strings.TrimSpace(params.Query)
		if params.Query == "" {
			return &ToolResult{Success: false, Error: "query is required"}, nil
		}
		if params.Limit <= 0 {
			params.Limit = 5
		}
		if params.Limit > 20 {
			params.Limit = 20
		}

		results, err := client.SearchKnowledge(
			toolCtx,
			ctx.AgentID,
			params.Query,
			params.KnowledgeBaseNames,
			params.KnowledgeBaseIDs,
			params.Limit,
		)
		if err != nil {
			slog.Warn("knowledge search failed", "error", err)
			return &ToolResult{Success: true, Data: "(no knowledge found)"}, nil
		}
		if len(results) == 0 {
			return &ToolResult{Success: true, Data: "(no knowledge found)"}, nil
		}

		var builder strings.Builder
		for index, result := range results {
			content := truncateKnowledgeContent(strings.TrimSpace(result.Content), 1600)
			builder.WriteString(fmt.Sprintf(
				"%d. [%s / %s] score=%.4f\n%s\n\n",
				index+1,
				result.KnowledgeBaseName,
				result.DocumentTitle,
				result.FinalScore,
				content,
			))
		}

		return &ToolResult{Success: true, Data: strings.TrimSpace(builder.String())}, nil
	})
}
