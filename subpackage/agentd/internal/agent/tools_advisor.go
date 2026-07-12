//go:build linux

package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
)

const advisorSystemPrompt = `You are an advisor model in an advisor-strategy pattern. An executor model is running a task end-to-end — calling tools, reading results, iterating toward a solution. When the executor hits a decision it cannot reasonably solve alone, it consults you for guidance.

You read the shared conversation context and return ONE of:
- a plan (concrete next steps the executor should take),
- a correction (the executor is going down a wrong path — redirect it),
- a stop signal (the executor should halt and escalate to the user).

You NEVER call tools. You NEVER produce user-facing output. Be concise, directive, and grounded in the shared context. Name files, functions, and line numbers where possible. No preamble, no apologies, no meta-commentary about being an advisor — just the guidance the executor needs.`

func registerAdvisor(registry *ToolRegistry, client *clawless.Client, ctx *AgentContext, model string) {
	registry.Register(ToolDefinition{
		Name:        "advisor",
		Description: "Escalate to a stronger reviewer model for guidance. When you need stronger judgment — a complex decision, an ambiguous failure, a problem you're circling without progress — escalate to the advisor for guidance, then resume. Takes NO parameters — your entire conversation history is automatically forwarded.",
		Parameters: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		if client == nil {
			return &ToolResult{Success: false, Error: "advisor not available: no LLM client configured"}, nil
		}

		messages := make([]clawless.Message, 0, len(ctx.RecentToolCalls)+2)
		messages = append(messages, clawless.Message{
			Role:    "system",
			Content: advisorSystemPrompt,
		})

		for _, tc := range ctx.RecentToolCalls {
			messages = append(messages, clawless.Message{
				Role:    "user",
				Content: fmt.Sprintf("[tool call: %s]\n%s", tc.Tool, tc.Args),
			})
			messages = append(messages, clawless.Message{
				Role:    "assistant",
				Content: tc.Result,
			})
		}

		if ctx.SessionSummary != "" {
			messages = append(messages, clawless.Message{
				Role:    "user",
				Content: "Current session context:\n" + ctx.SessionSummary,
			})
		}

		advisorModel := model
		if advisorModel == "" {
			advisorModel = "claude-sonnet-4-20250514"
		}

		req := &clawless.LLMProxyRequest{
			Model:    advisorModel,
			Messages: messages,
			Stream:   false,
		}

		slog.Info("advisor called", "model", advisorModel, "context_messages", len(messages))

		data, err := client.LLMProxyRequest(toolCtx, req)
		if err != nil {
			slog.Warn("advisor call failed", "error", err)
			return &ToolResult{
				Success: false,
				Error:   fmt.Sprintf("advisor call failed: %v", err),
			}, nil
		}

		return &ToolResult{
			Success: true,
			Data:    string(data),
		}, nil
	})
}
