package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/security"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/usertype"
)

// Message represents a chat message in the agent loop's conversation
// history. It mirrors clawless.Message's tool-calling fields so the
// full OpenAI tool-calling protocol is preserved end-to-end:
//
//   - role="assistant" messages carry ToolCalls (model's request to
//     invoke tools). Storing these (not just the text Content) is what
//     lets the next callLLM present a coherent assistant→tool pairing
//     to the model; dropping them used to orphan tool results.
//   - role="tool" messages carry ToolCallID linking back to the
//     originating ToolCall.ID. OpenAI/Anthropic/Gemini all require this.
type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`   // role=assistant
	ToolCallID string     `json:"tool_call_id,omitempty"` // role=tool
	Name       string     `json:"name,omitempty"`         // optional tool name (role=tool)
}

// ToolCall represents a tool invocation request from the LLM.
type ToolCall struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

// compactionThreshold is the number of messages before we trigger compaction.
const compactionThreshold = 50

// AgentLoop implements the think→act→observe reasoning loop.
type AgentLoop struct {
	registry       *ToolRegistry
	agentCtx       *AgentContext
	clawless       *clawless.Client
	llmEndpoint    string
	llmModel       string
	llmAPIKey      string
	l1Scorer       clawless.L1Scorer
	gatekeeper     *security.Gatekeeper
	messages       []Message
	stepCount      int
	maxSteps       int
	autoCheckpoint bool
	// sbMgr is required for auto-checkpoint dispatch (resolves the right
	// checkpoint backend per sandbox type). Nil disables auto-checkpoint.
	sbMgr *sandbox.Manager
	// warnedGitMissing suppresses repeated warn logs when a sandbox image
	// lacks git and auto-checkpoint therefore degrades to a no-op. Accessed
	// from both the main loop and the auto-checkpoint goroutine, so it must
	// be atomic — a plain bool here was a data race (two checkpoint
	// goroutines from consecutive write/exec calls could read+write it
	// concurrently, and `go test -race` would flag it).
	warnedGitMissing atomic.Bool
}

// NewAgentLoop creates a new agent loop.
func NewAgentLoop(
	registry *ToolRegistry,
	agentCtx *AgentContext,
	clawlessClient *clawless.Client,
	llmEndpoint, llmModel, llmAPIKey string,
	l1Scorer clawless.L1Scorer,
	gatekeeper *security.Gatekeeper,
	sbMgr *sandbox.Manager,
) *AgentLoop {
	return &AgentLoop{
		registry:       registry,
		agentCtx:       agentCtx,
		clawless:       clawlessClient,
		llmEndpoint:    llmEndpoint,
		llmModel:       llmModel,
		llmAPIKey:      llmAPIKey,
		l1Scorer:       l1Scorer,
		gatekeeper:     gatekeeper,
		messages:       make([]Message, 0),
		maxSteps:       agentCtx.MaxSteps,
		sbMgr:          sbMgr,
		autoCheckpoint: sbMgr != nil,
	}
}

// Run executes the agent loop until completion or max steps.
func (l *AgentLoop) Run(ctx context.Context, userMessage string) (string, error) {
	l.messages = append(l.messages, Message{Role: "user", Content: userMessage})

	// Hoisted out of the loop: Log() is cheap (slog.With) but was being
	// re-invoked every iteration, and two branch sites below still called
	// l.agentCtx.Log() ad-hoc. One logger for the whole run.
	log := l.agentCtx.Log()

	for l.stepCount < l.maxSteps {
		l.stepCount++
		log.Info("Agent Loop: step", "step", l.stepCount, "session", l.agentCtx.SessionID)

		// Compact context if message count exceeds threshold
		if len(l.messages) >= compactionThreshold {
			if err := l.compactContext(ctx); err != nil {
				log.Warn("compaction failed, continuing", "error", err)
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
			stampReviewLogs(auditLogs, l.agentCtx)
			if len(auditLogs) > 0 {
				if err := l.clawless.WriteReviewLogs(ctx, auditLogs); err != nil {
					log.Warn("failed to write output audit logs", "error", err)
				}
			}
			if auditResult.Decision == "blocked" {
				log.Warn("LLM output blocked by security audit", "reason", auditResult.Reason)
				// Inject a safe replacement message
				l.messages = append(l.messages, Message{
					Role:    "assistant",
					Content: "抱歉，我的输出被安全审查拦截。原因：" + auditResult.Reason + "。请重新表述您的请求。",
				})
				return l.messages[len(l.messages)-1].Content, nil
			}
		}

		// Add assistant message — preserving ALL tool_calls the model
		// emitted, not just the executed one. Previously only Content was
		// stored (P9: that orphaned the subsequent role=tool result). We
		// now store the full ToolCalls slice so history faithfully records
		// the model's intent — if it requested N parallel calls, the next
		// turn sees all N even though the loop only executes the first.
		// The role=tool result pairs up with the first ToolCall.ID; the
		// model can observe the other N-1 went unanswered and retry them.
		assistantMsg := Message{Role: "assistant", Content: llmResp.Content}
		if len(llmResp.ToolCalls) > 0 {
			assistantMsg.ToolCalls = llmResp.ToolCalls
		} else if llmResp.ToolCall != nil {
			// Defensive: callLLM should populate ToolCalls when ToolCall is
			// set, but don't depend on it for protocol correctness.
			assistantMsg.ToolCalls = []ToolCall{*llmResp.ToolCall}
		}
		l.messages = append(l.messages, assistantMsg)

		// Execute tool calls. The OpenAI tool-calling protocol requires that
		// EVERY entry in assistant.tool_calls has a matching role=tool result
		// before the next LLM turn — otherwise the provider 400s ("tool_call_ids
		// did not have response messages"). The loop executes them SEQUENTIALLY
		// (simpler than parallel; preserves ordering; each goes through the
		// gatekeeper individually) and appends one tool message per call.
		// With NO tool calls at all, this is the final-answer turn.
		if len(llmResp.ToolCalls) == 0 && llmResp.ToolCall == nil {
			log.Info("Agent Loop: final answer", "step", l.stepCount)
			return llmResp.Content, nil
		}

		var calls []ToolCall
		if len(llmResp.ToolCalls) > 0 {
			calls = llmResp.ToolCalls
		} else {
			// Legacy single-call path (defensive; callLLM should populate
			// ToolCalls when ToolCall is set, but don't depend on it).
			calls = []ToolCall{*llmResp.ToolCall}
		}
		for _, tc := range calls {
			l.executeOneToolCall(ctx, &tc)
		}
	}

	return "", fmt.Errorf("agent loop exceeded max steps (%d)", l.maxSteps)
}

// executeOneToolCall runs a single tool call end-to-end: registry
// lookup, permission check, gatekeeper audit, execution, and appending
// the role=tool result message. Extracted from Run so the loop can
// process ALL of an assistant turn's tool_calls (OpenAI requires a
// tool result for each tool_call.id; leaving any unanswered 400s the
// next request). Errors at each stage produce a synthetic tool result
// (so the pairing invariant holds) rather than aborting the turn.
func (l *AgentLoop) executeOneToolCall(ctx context.Context, call *ToolCall) {
	toolStartedAt := time.Now()

	toolDef, _, ok := l.registry.Get(call.Name)
	if !ok {
		l.completeToolCall(ctx, call, &ToolResult{Success: false, Error: fmt.Sprintf("unknown tool: %s", call.Name)}, toolStartedAt)
		return
	}
	if !usertype.CanUse(l.agentCtx.Roles, toolDef.MinUserType) {
		l.completeToolCall(ctx, call, &ToolResult{
			Success: false,
			Error:   fmt.Sprintf("permission denied: tool %s requires %s", call.Name, toolDef.MinUserType),
		}, toolStartedAt)
		return
	}

	if l.gatekeeper != nil {
		auditTaskID := l.agentCtx.TaskID
		if auditTaskID == "" {
			auditTaskID = "00000000-0000-0000-0000-000000000000"
		}
		// Snapshot SandboxID under the per-session state lock (nil-safe
		// no-op for detached sub-agent loops): sandbox_destroy clears it
		// concurrently with tool dispatch.
		auditSandboxID := l.agentCtx.SnapshotSandboxID()
		auditTask := &clawless.Task{
			ID:        auditTaskID,
			AgentID:   l.agentCtx.AgentID,
			SessionID: l.agentCtx.SessionID,
			UserID:    l.agentCtx.UserID,
			Roles:     l.agentCtx.Roles,
			Source:    l.agentCtx.Source,
			SandboxID: auditSandboxID,
			RunID:     l.agentCtx.RunID,
			Command:   fmt.Sprintf("tool=%s args=%s", call.Name, string(call.Arguments)),
		}
		auditResult, auditLogs := l.gatekeeper.Audit(ctx, auditTask, l.agentCtx.SessionSummary)
		stampReviewLogs(auditLogs, l.agentCtx)
		if len(auditLogs) > 0 {
			if err := l.clawless.WriteReviewLogs(ctx, auditLogs); err != nil {
				l.agentCtx.Log().Warn("failed to write tool audit logs", "error", err)
			}
		}
		if auditResult.Decision != security.DecisionAllowed {
			l.completeToolCall(ctx, call, &ToolResult{
				Success: false,
				Error:   fmt.Sprintf("tool blocked by security review: %s", auditResult.Reason),
			}, toolStartedAt)
			return
		}
	}

	toolResult, err := l.registry.Execute(ctx, call.Name, call.Arguments)
	if err != nil {
		toolResult = &ToolResult{Success: false, Error: err.Error()}
	}
	l.completeToolCall(ctx, call, toolResult, toolStartedAt)
}

func stampReviewLogs(logs []clawless.ReviewLog, agentCtx *AgentContext) {
	if agentCtx == nil {
		return
	}

	taskID := agentCtx.TaskID
	if taskID == "" {
		taskID = "00000000-0000-0000-0000-000000000000"
	}
	for i := range logs {
		if logs[i].TaskID == "" {
			logs[i].TaskID = taskID
		}
		if logs[i].RunID == "" {
			logs[i].RunID = agentCtx.RunID
		}
		if logs[i].IdempotencyKey == "" {
			logs[i].IdempotencyKey = fmt.Sprintf(
				"review:%s:%s:%s:%s",
				logs[i].TaskID,
				logs[i].Level,
				logs[i].Decision,
				logs[i].Command,
			)
		}
		if logs[i].UserID == "" {
			logs[i].UserID = agentCtx.UserID
		}
		if len(logs[i].Roles) == 0 {
			logs[i].Roles = agentCtx.Roles
		}
	}
}

// LLMResponse represents the parsed LLM response.
//
// ToolCall holds the first tool call (the loop executes one tool per
// turn). ToolCalls holds ALL tool calls the model emitted, preserved
// verbatim into the assistant message so the conversation history
// faithfully records the model's intent. Storing only the executed call
// would silently rewrite history when the model requests parallel
// calls — the next turn would show the model "asked for 1 tool" when
// it actually asked for N, confusing it. ToolCalls may be longer than
// the calls actually executed; the role=tool result pairs up with the
// first entry only.
type LLMResponse struct {
	Content   string
	ToolCall  *ToolCall  // first call, for legacy single-tool execution
	ToolCalls []ToolCall // all calls, for faithful history storage
}

// callLLM sends a request to the LLM via ClawLess proxy.
//
// It converts the loop's Message history to clawless.Message while
// preserving tool_calls (role=assistant) and tool_call_id (role=tool),
// and forwards the registry's tool definitions so the upstream provider
// can perform native OpenAI-style tool calling rather than relying on
// prompt-based translation. See P9 in the reliability audit.
func (l *AgentLoop) callLLM(ctx context.Context, systemPrompt string, messages []Message) (*LLMResponse, error) {
	return l.callLLMWithTools(ctx, systemPrompt, messages, true)
}

// callLLMWithTools is the parameterized core. withTools=false omits the
// tools field from the upstream request — used by generateCompactionSummary,
// which wants a plain text summary, NOT a tool call. Sending tools to a
// summary request can make the model try to invoke a tool instead of
// summarizing, breaking compaction.
func (l *AgentLoop) callLLMWithTools(ctx context.Context, systemPrompt string, messages []Message, withTools bool) (*LLMResponse, error) {
	// Build messages with system prompt
	allMessages := make([]Message, 0, len(messages)+1)
	allMessages = append(allMessages, Message{Role: "system", Content: systemPrompt})
	allMessages = append(allMessages, messages...)

	// Convert messages to clawless.Message, preserving tool-calling fields.
	clawlessMsgs := buildProxyMessages(allMessages)

	req := clawless.LLMProxyRequest{
		Model:    l.llmModel,
		Messages: clawlessMsgs,
		Stream:   false,
	}

	// Forward tool definitions for native tool calling — but ONLY when the
	// caller wants them (the main loop does; the compaction summary does
	// not). We normalize each tool's Parameters (any) to a JSON-Schema-ish
	// map so providers that require a schema (OpenAI) accept the request.
	if withTools {
		if defs := l.registry.Definitions(); len(defs) > 0 {
			tools := make([]clawless.ToolDef, 0, len(defs))
			for _, def := range defs {
				params := normalizeToolParams(def.Parameters)
				tools = append(tools, clawless.ToolDef{
					Type: "function",
					Function: clawless.ToolDefFunction{
						Name:        def.Name,
						Description: def.Description,
						Parameters:  params,
					},
				})
			}
			req.Tools = tools
		}
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
		// Parse ALL tool calls the model emitted so the assistant message
		// can faithfully record them (see LLMResponse docs). The loop
		// still executes only the first per turn — ToolCall points at it
		// for the single-tool execution path, ToolCalls carries the rest
		// for history fidelity.
		tcs := make([]ToolCall, len(msg.ToolCalls))
		for i, tc := range msg.ToolCalls {
			tcs[i] = ToolCall{
				ID:        tc.ID,
				Name:      tc.Function.Name,
				Arguments: json.RawMessage(tc.Function.Arguments),
			}
		}
		resp.ToolCalls = tcs
		// Backward-compat: ToolCall is the first one (what the loop executes).
		first := msg.ToolCalls[0]
		resp.ToolCall = &ToolCall{
			ID:        first.ID,
			Name:      first.Function.Name,
			Arguments: json.RawMessage(first.Function.Arguments),
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

	// Tool definitions as plain text in the system prompt. NOTE: since P9
	// we ALSO forward the full JSON-Schema tools via LLMProxyRequest.Tools
	// for native tool calling. The two paths are complementary, not
	// redundant: the text list is a low-token overview the model can refer
	// to regardless of whether the upstream provider injects the tool
	// schemas into its own prompt (OpenAI does; some proxy shims don't).
	// Keeping this list means tool calling still works even if a future
	// provider config silently drops the Tools field.
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
	l.agentCtx.Log().Info("compacting context", "messages", len(l.messages), "session", l.agentCtx.SessionID)

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

	// P9: drop any leading role=tool messages in the kept tail that
	// have no preceding assistant tool_call to pair with. Compaction's
	// keep-N slice can split an assistant(tool_calls) → tool(tool_call_id)
	// pair, leaving an orphan tool result; feeding that to the provider
	// re-introduces the exact protocol violation P9 fixed (OpenAI 400s on
	// missing tool_call_id pairing). Drop leading tool messages whose
	// ToolCallID isn't referenced by any earlier kept assistant tool_call.
	compacted = dropOrphanToolResults(compacted)

	l.messages = compacted
	// Loop-progress state is OBSERVABLE: session-status readers
	// (GetSessionStatus/GetAllSessionStatuses) report CompactionCount
	// live and session serialization snapshots SessionSummary. Commit
	// under the per-session state lock (nil/no-op for sub-agent loops,
	// whose contexts are single-goroutine-owned).
	l.agentCtx.WithStateLock(func() {
		l.agentCtx.TaskState.CompactionCount++
		l.agentCtx.TaskState.CompactedAt = time.Now().UTC().Format(time.RFC3339)

		// Persist compaction summary to session store
		l.agentCtx.SessionSummary = summary
	})

	l.agentCtx.Log().Info("compaction complete", "before", len(l.messages)+keepCount+1, "after", len(l.messages))
	return nil
}

// saveTaskState captures current execution state before compaction.
// Enhanced to identify key decision points: requirement changes, retry-after-failure,
// and technical approach selections — not just recent tool results.
//
// The whole body runs under the per-session state lock: it reads
// RecentToolCalls (appended by completeToolCall under the same lock)
// and writes TaskState fields observed by status readers. The lock is
// nil (no-op) for sub-agent loops.
func (l *AgentLoop) saveTaskState() {
	l.agentCtx.WithStateLock(func() { l.saveTaskStateLocked() })
}

// saveTaskStateLocked is saveTaskState's body; caller holds the state lock.
func (l *AgentLoop) saveTaskStateLocked() {
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
	// withTools=false: a compaction summary must NOT advertise tools —
	// otherwise the model may emit a tool_call instead of summarizing,
	// breaking the compaction (the result would be treated as a summary
	// string and the loop would lose the actual tool-call attempt).
	resp, err := l.callLLMWithTools(ctx, l.buildSystemPrompt(), l.messages, false)
	l.messages = origMessages // restore

	if err != nil {
		return "", err
	}

	return resp.Content, nil
}

// normalizeToolParams converts a ToolDefinition.Parameters (typed as
// `any` but expected to be a JSON-Schema object) into the
// map[string]any shape clawless.ToolDefFunction requires. nil/non-map
// values fall back to a permissive empty object schema so the upstream
// provider still accepts the tool declaration.
func normalizeToolParams(p any) map[string]any {
	if p == nil {
		return map[string]any{
			"type":                 "object",
			"properties":           map[string]any{},
			"additionalProperties": true,
		}
	}
	if m, ok := p.(map[string]any); ok {
		return m
	}
	return map[string]any{
		"type":                 "object",
		"properties":           map[string]any{},
		"additionalProperties": true,
	}
}

// dropOrphanToolResults removes any role=tool messages whose
// ToolCallID has no preceding assistant tool_call to pair with.
// compactContext's keep-N slice can split an assistant(tool_calls) →
// tool(tool_call_id) pair across the cut, leaving an orphan tool result
// in the kept tail. Feeding that to the provider re-introduces the
// exact protocol violation P9 fixed (OpenAI 400 "tool message without
// prior tool_call").
//
// IMPORTANT: we FILTER (drop only the orphan tool rows) rather than
// truncate the prefix. An earlier draft did msgs[firstKept:] which
// silently discarded leading system messages and the compaction summary
// — catastrophic because system messages carry the safety prompt and
// tool list. We scan the whole list: any role=tool row whose ToolCallID
// isn't backed by an assistant tool_call we've already seen (anywhere
// earlier in the list) gets dropped; everything else (system, summary,
// user, assistant, paired tool) stays in order.
func dropOrphanToolResults(msgs []Message) []Message {
	// First pass: collect every assistant tool_call ID present in the
	// kept window. A tool result is orphan iff its caller was dropped.
	seen := make(map[string]bool, len(msgs))
	for _, m := range msgs {
		if m.Role == "assistant" {
			for _, tc := range m.ToolCalls {
				seen[tc.ID] = true
			}
		}
	}
	out := make([]Message, 0, len(msgs))
	for _, m := range msgs {
		if m.Role == "tool" && !seen[m.ToolCallID] {
			continue // orphan: drop, keep everything else
		}
		out = append(out, m)
	}
	return out
}

// buildProxyMessages converts the loop's internal Message history into
// the clawless.Message wire shape, preserving the tool-calling fields
// (role=assistant → tool_calls, role=tool → tool_call_id) required by
// the OpenAI/Anthropic/Gemini tool-calling protocol. Extracted from
// callLLM so the pairing invariants can be unit-tested without an LLM.
func buildProxyMessages(msgs []Message) []clawless.Message {
	out := make([]clawless.Message, len(msgs))
	for i, m := range msgs {
		cm := clawless.Message{
			Role:       m.Role,
			Content:    m.Content,
			ToolCallID: m.ToolCallID,
			Name:       m.Name,
		}
		if len(m.ToolCalls) > 0 {
			tcs := make([]clawless.ToolCall, len(m.ToolCalls))
			for j, tc := range m.ToolCalls {
				tcs[j] = clawless.ToolCall{
					ID:   tc.ID,
					Type: "function",
					Function: clawless.ToolCallFunction{
						Name:      tc.Name,
						Arguments: string(tc.Arguments),
					},
				}
			}
			cm.ToolCalls = tcs
		}
		out[i] = cm
	}
	return out
}
