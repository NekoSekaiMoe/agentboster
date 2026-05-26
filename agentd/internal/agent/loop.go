package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/security"
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

// compactionThreshold is the number of messages before we trigger compaction.
const compactionThreshold = 50

// AgentLoop implements the think→act→observe reasoning loop.
type AgentLoop struct {
	registry      *ToolRegistry
	agentCtx      *AgentContext
	clawless      *clawless.Client
	llmEndpoint   string
	llmModel      string
	llmAPIKey     string
	l1Scorer      *l1_scorer.L1Scorer
	gatekeeper    *security.Gatekeeper
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
	gatekeeper *security.Gatekeeper,
) *AgentLoop {
	return &AgentLoop{
		registry:    registry,
		agentCtx:    agentCtx,
		clawless:    clawlessClient,
		llmEndpoint: llmEndpoint,
		llmModel:    llmModel,
		llmAPIKey:   llmAPIKey,
		l1Scorer:    l1Scorer,
		gatekeeper:  gatekeeper,
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

		// Compact context if message count exceeds threshold
		if len(l.messages) >= compactionThreshold {
			if err := l.compactContext(ctx); err != nil {
				slog.Warn("compaction failed, continuing", "error", err)
			}
		}

		// Build context-injected system prompt
		systemPrompt := l.buildSystemPrompt()

		// Call LLM
		llmResp, err := l.callLLM(ctx, systemPrompt, l.messages)
		if err != nil {
			return "", fmt.Errorf("LLM call failed at step %d: %w", l.stepCount, err)
		}

		// Security validation: check LLM output for injection/leak patterns
		if llmResp.Content != "" && l.gatekeeper != nil {
			auditResult, auditLogs := l.gatekeeper.AuditOutput(ctx, llmResp.Content, l.agentCtx.SessionSummary)
			if len(auditLogs) > 0 {
				if err := l.clawless.WriteReviewLogs(ctx, auditLogs); err != nil {
					slog.Warn("failed to write output audit logs", "error", err)
				}
			}
			if auditResult.Decision == "blocked" {
				slog.Warn("LLM output blocked by security audit", "reason", auditResult.Reason)
				// Inject a safe replacement message
				l.messages = append(l.messages, Message{
					Role:    "assistant",
					Content: "抱歉，我的输出被安全审查拦截。原因：" + auditResult.Reason + "。请重新表述您的请求。",
				})
				return l.messages[len(l.messages)-1].Content, nil
			}
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

// compactContext summarizes older messages and preserves task state.
// Keeps system prompt + last 10 messages + compaction summary.
func (l *AgentLoop) compactContext(ctx context.Context) error {
	slog.Info("compacting context", "messages", len(l.messages), "session", l.agentCtx.SessionID)

	// 1. Save current task state before compaction
	l.saveTaskState()

	// 2. Generate summary of older messages via LLM
	summary, err := l.generateCompactionSummary(ctx)
	if err != nil {
		return fmt.Errorf("generate compaction summary: %w", err)
	}

	// 3. Keep system prompt (first message) + last 10 messages
	keepCount := 10
	if len(l.messages) <= keepCount+1 {
		return nil // nothing to compact
	}

	// Find system message
	sysIdx := -1
	for i, msg := range l.messages {
		if msg.Role == "system" {
			sysIdx = i
			break
		}
	}

	// Build compacted message list
	compacted := make([]Message, 0, keepCount+2)
	if sysIdx >= 0 {
		compacted = append(compacted, l.messages[sysIdx])
	}

	// Add compaction summary as system message
	summaryMsg := Message{
		Role:    "system",
		Content: fmt.Sprintf("## 上下文压缩摘要\n%s\n\n（之前的对话已压缩。上方是关键摘要，下方是最近的对话记录。）", summary),
	}
	compacted = append(compacted, summaryMsg)

	// Keep last N messages
	start := len(l.messages) - keepCount
	if start < 0 {
		start = 0
	}
	// Skip system message if it's in the tail
	for i := start; i < len(l.messages); i++ {
		if l.messages[i].Role != "system" {
			compacted = append(compacted, l.messages[i])
		}
	}

	l.messages = compacted
	l.agentCtx.TaskState.CompactionCount++
	l.agentCtx.TaskState.CompactedAt = time.Now().UTC().Format(time.RFC3339)

	// Persist compaction summary to session store
	l.agentCtx.SessionSummary = summary

	slog.Info("compaction complete", "before", len(l.messages)+keepCount+1, "after", len(l.messages))
	return nil
}

// saveTaskState captures current execution state before compaction.
// Enhanced to identify key decision points: requirement changes, retry-after-failure,
// and technical approach selections — not just recent tool results.
func (l *AgentLoop) saveTaskState() {
	l.agentCtx.TaskState.SandboxType = l.agentCtx.SandboxType
	l.agentCtx.TaskState.SandboxID = l.agentCtx.SandboxID

	// Extract key decisions from recent tool calls with decision-point detection
	decisions := make([]string, 0, 5)
	var lastToolSummary string

	for i := len(l.agentCtx.RecentToolCalls) - 1; i >= 0; i-- {
		tc := l.agentCtx.RecentToolCalls[i]

		if lastToolSummary == "" {
			lastToolSummary = fmt.Sprintf("%s(%s) → %s",
				tc.Tool, truncate(tc.Args, 100), truncate(tc.Result, 200))
		}

		if len(decisions) >= 5 {
			break
		}

		// Detect failure-then-retry pattern (key decision point)
		if !tc.Success && i > 0 {
			prevTool := l.agentCtx.RecentToolCalls[i-1]
			if prevTool.Tool == tc.Tool {
				decisions = append(decisions,
					fmt.Sprintf("[RETRY] %s failed then retried: %s",
						tc.Tool, truncate(tc.Result, 100)))
				continue
			}
		}

		// Detect file modification decisions
		if tc.Success && (tc.Tool == "write" || tc.Tool == "edit" || tc.Tool == "patch") {
			decisions = append(decisions,
				fmt.Sprintf("[FILE] %s: %s", tc.Tool, truncate(tc.Args, 120)))
			continue
		}

		// Detect git operations (commit decisions)
		if tc.Success && (tc.Tool == "git_commit" || tc.Tool == "git_push") {
			decisions = append(decisions,
				fmt.Sprintf("[GIT] %s: %s", tc.Tool, truncate(tc.Result, 100)))
			continue
		}

		// Include other successful tool results
		if tc.Success && len(decisions) < 3 {
			decisions = append(decisions,
				fmt.Sprintf("%s: %s", tc.Tool, truncate(tc.Result, 150)))
		}
	}

	l.agentCtx.TaskState.LastToolSummary = lastToolSummary
	l.agentCtx.TaskState.KeyDecisions = decisions
}

// generateCompactionSummary asks the LLM to summarize the conversation.
// Enhanced to explicitly preserve key decision points.
func (l *AgentLoop) generateCompactionSummary(ctx context.Context) (string, error) {
	var sb strings.Builder
	sb.WriteString("请用中文总结以下对话的关键信息。\n\n")
	sb.WriteString("必须保留的关键决策点：\n")
	sb.WriteString("- 用户中途修改需求的节点\n")
	sb.WriteString("- Agent 选择的技术方案及原因\n")
	sb.WriteString("- 失败后重试并更换策略的转折点\n")
	sb.WriteString("- 关键的文件路径、命令、错误信息\n\n")
	sb.WriteString("同时总结：\n")
	sb.WriteString("1. 正在执行的任务目标\n")
	sb.WriteString("2. 已完成的关键步骤\n")
	sb.WriteString("3. 当前状态（沙箱、文件、进程）\n")
	sb.WriteString("4. 下一步计划\n\n")

	// Include all messages except the last few (which will be kept)
	limit := len(l.messages) - 10
	if limit > 0 {
		sb.WriteString("--- 对话历史 ---\n")
		for i := 0; i < limit && i < len(l.messages); i++ {
			msg := l.messages[i]
			if msg.Role == "system" {
				continue
			}
			sb.WriteString(fmt.Sprintf("[%s] %s\n\n", msg.Role, truncate(msg.Content, 500)))
		}
	}

	summaryReq := Message{
		Role:    "user",
		Content: sb.String(),
	}

	// Temporarily replace messages with just system + summary request
	origMessages := l.messages
	summaryMessages := []Message{}
	// Keep system message
	for _, m := range origMessages {
		if m.Role == "system" {
			summaryMessages = append(summaryMessages, m)
			break
		}
	}
	summaryMessages = append(summaryMessages, summaryReq)

	l.messages = summaryMessages
	resp, err := l.callLLM(ctx, l.buildSystemPrompt(), l.messages)
	l.messages = origMessages // restore

	if err != nil {
		return "", err
	}

	return resp.Content, nil
}
