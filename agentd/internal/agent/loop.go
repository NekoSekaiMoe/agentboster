package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/security/l1_scorer"
)

// Message represents a chat message.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ToolCall represents a tool invocation request from the LLM.
type ToolCall struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

// AgentLoop implements the think→act→observe reasoning loop.
type AgentLoop struct {
	registry      *ToolRegistry
	agentCtx      *AgentContext
	clawless      *clawless.Client
	llmEndpoint   string
	llmModel      string
	llmAPIKey     string
	l1Scorer      *l1_scorer.L1Scorer
	messages      []Message
	stepCount     int
	maxSteps      int
}

// NewAgentLoop creates a new agent loop.
func NewAgentLoop(
	registry *ToolRegistry,
	agentCtx *AgentContext,
	clawlessClient *clawless.Client,
	llmEndpoint, llmModel, llmAPIKey string,
	l1Scorer *l1_scorer.L1Scorer,
) *AgentLoop {
	return &AgentLoop{
		registry:    registry,
		agentCtx:    agentCtx,
		clawless:    clawlessClient,
		llmEndpoint: llmEndpoint,
		llmModel:    llmModel,
		llmAPIKey:   llmAPIKey,
		l1Scorer:    l1Scorer,
		messages:    make([]Message, 0),
		maxSteps:    agentCtx.MaxSteps,
	}
}

// Run executes the agent loop until completion or max steps.
func (l *AgentLoop) Run(ctx context.Context, userMessage string) (string, error) {
	l.messages = append(l.messages, Message{Role: "user", Content: userMessage})

	for l.stepCount < l.maxSteps {
		l.stepCount++
		slog.Info("Agent Loop: step", "step", l.stepCount, "session", l.agentCtx.SessionID)

		// Build context-injected system prompt
		systemPrompt := l.buildSystemPrompt()

		// Call LLM
		llmResp, err := l.callLLM(ctx, systemPrompt, l.messages)
		if err != nil {
			return "", fmt.Errorf("LLM call failed at step %d: %w", l.stepCount, err)
		}

		// Add assistant message
		l.messages = append(l.messages, Message{Role: "assistant", Content: llmResp.Content})

		// Check if LLM wants to call a tool
		if llmResp.ToolCall == nil {
			// No tool call — final answer
			slog.Info("Agent Loop: final answer", "step", l.stepCount)
			return llmResp.Content, nil
		}

		// Execute tool
		toolResult, err := l.registry.Execute(ctx, llmResp.ToolCall.Name, llmResp.ToolCall.Arguments)
		if err != nil {
			toolResult = &ToolResult{Success: false, Error: err.Error()}
		}

		// Record tool call
		l.agentCtx.RecentToolCalls = append(l.agentCtx.RecentToolCalls, ToolCallRecord{
			Tool:    llmResp.ToolCall.Name,
			Args:    string(llmResp.ToolCall.Arguments),
			Result:  toolResult.Data,
			Success: toolResult.Success,
			Time:    time.Now(),
		})
		// Keep only last 5
		if len(l.agentCtx.RecentToolCalls) > 5 {
			l.agentCtx.RecentToolCalls = l.agentCtx.RecentToolCalls[len(l.agentCtx.RecentToolCalls)-5:]
		}

		// Add tool result message
		resultJSON, _ := json.Marshal(toolResult)
		l.messages = append(l.messages, Message{
			Role:    "tool",
			Content: string(resultJSON),
		})
	}

	return "", fmt.Errorf("agent loop exceeded max steps (%d)", l.maxSteps)
}

// LLMResponse represents the parsed LLM response.
type LLMResponse struct {
	Content  string
	ToolCall *ToolCall
}

// callLLM sends a request to the LLM via ClawLess proxy.
func (l *AgentLoop) callLLM(ctx context.Context, systemPrompt string, messages []Message) (*LLMResponse, error) {
	// Build messages with system prompt
	allMessages := make([]Message, 0, len(messages)+1)
	allMessages = append(allMessages, Message{Role: "system", Content: systemPrompt})
	allMessages = append(allMessages, messages...)

	// Convert messages to clawless.Message
	clawlessMsgs := make([]clawless.Message, len(allMessages))
	for i, m := range allMessages {
		clawlessMsgs[i] = clawless.Message{Role: m.Role, Content: m.Content}
	}

	req := clawless.LLMProxyRequest{
		Model:    l.llmModel,
		Messages: clawlessMsgs,
		Stream:   false,
	}

	// Call ClawLess LLM proxy
	respData, err := l.clawless.LLMProxyRequest(ctx, &req)
	if err != nil {
		return nil, fmt.Errorf("LLM proxy request: %w", err)
	}

	// Parse response
	var proxyResp struct {
		Choices []struct {
			Message struct {
				Content   string `json:"content"`
				ToolCalls []struct {
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
	}

	if err := json.Unmarshal(respData, &proxyResp); err != nil {
		// Fallback: treat entire response as content
		return &LLMResponse{Content: string(respData)}, nil
	}

	if len(proxyResp.Choices) == 0 {
		return nil, fmt.Errorf("no choices in LLM response")
	}

	msg := proxyResp.Choices[0].Message
	resp := &LLMResponse{Content: msg.Content}

	if len(msg.ToolCalls) > 0 {
		tc := msg.ToolCalls[0]
		resp.ToolCall = &ToolCall{
			ID:        tc.ID,
			Name:      tc.Function.Name,
			Arguments: json.RawMessage(tc.Function.Arguments),
		}
	}

	return resp, nil
}

// buildSystemPrompt assembles the full system prompt with context injection.
func (l *AgentLoop) buildSystemPrompt() string {
	var sb strings.Builder

	sb.WriteString(l.agentCtx.SystemPrompt)
	sb.WriteString("\n\n")
	sb.WriteString(l.agentCtx.BuildSystemPromptContext())

	// Tool definitions
	sb.WriteString("\n## 可用工具\n")
	for _, def := range l.registry.Definitions() {
		sb.WriteString(fmt.Sprintf("- %s: %s\n", def.Name, def.Description))
	}

	return sb.String()
}

// GetMessages returns the conversation history.
func (l *AgentLoop) GetMessages() []Message {
	return l.messages
}
