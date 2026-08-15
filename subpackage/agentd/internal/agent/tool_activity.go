package agent

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
)

func (l *AgentLoop) completeToolCall(ctx context.Context, call *ToolCall, result *ToolResult, startedAt time.Time) {
	if result == nil {
		result = &ToolResult{Success: false, Error: "tool returned nil result"}
	}

	resultJSON, err := json.Marshal(result)
	if err != nil {
		resultJSON = []byte(`{"success":false,"error":"marshal tool result failed"}`)
	}

	completedAt := time.Now()
	l.writeToolActivityLog(ctx, call, result, string(resultJSON), startedAt, completedAt)

	// RecentToolCalls is shared session state (read by session
	// serialization and BuildSystemPromptContext consumers); append/trim
	// under the per-session state lock. Nil/no-op for sub-agent loops.
	l.agentCtx.WithStateLock(func() {
		l.agentCtx.RecentToolCalls = append(l.agentCtx.RecentToolCalls, ToolCallRecord{
			Tool:    call.Name,
			Args:    string(call.Arguments),
			Result:  result.Data,
			Success: result.Success,
			Time:    completedAt,
		})
		if len(l.agentCtx.RecentToolCalls) > 5 {
			l.agentCtx.RecentToolCalls = l.agentCtx.RecentToolCalls[len(l.agentCtx.RecentToolCalls)-5:]
		}
	})

	l.messages = append(l.messages, Message{
		Role:       "tool",
		Content:    string(resultJSON),
		ToolCallID: call.ID, // pair this result with the assistant's tool_call (P9)
		Name:       call.Name,
	})

	// Auto-checkpoint after mutating tools.
	if l.autoCheckpoint && call.Name != "" && result.Success {
		switch call.Name {
		case "write", "edit", "patch", "exec", "exec_batch", "git_push":
			desc := call.Name
			// Snapshot the sandbox identity under the per-session state
			// lock (nil-safe no-op for detached sub-agent loops):
			// sandbox_destroy clears these fields concurrently.
			var ref SandboxRef
			l.agentCtx.WithStateLock(func() {
				ref = SandboxRef{
					Type:     l.agentCtx.SandboxType,
					ID:       l.agentCtx.SandboxID,
					HostPath: l.agentCtx.SandboxPath,
				}
			})
			go func() {
				_, cpErr := CreateCheckpoint(ref, l.sbMgr, l.agentCtx.SessionID, desc)
				switch {
				case cpErr == nil:
					return
				case errors.Is(cpErr, ErrGitUnavailableInContainer):
					// Common in minimal images (alpine/ubuntu base). Log once
					// per loop at warn level so it's visible without spamming.
					// CompareAndSwap makes the "log once" check atomic against
					// concurrent checkpoint goroutines from other write/exec calls.
					if !l.warnedGitMissing.CompareAndSwap(false, true) {
						return
					}
					slog.Warn("auto-checkpoint disabled: sandbox image has no git", "sandbox_type", ref.Type, "sandbox_id", ref.ID)
				default:
					slog.Debug("auto-checkpoint failed", "error", cpErr)
				}
			}()
		}
	}
}

func (l *AgentLoop) writeToolActivityLog(
	ctx context.Context,
	call *ToolCall,
	result *ToolResult,
	outputText string,
	startedAt time.Time,
	completedAt time.Time,
) {
	writeToolActivityLog(ctx, l.clawless, l.agentCtx, l.llmModel, l.stepCount, call, result, outputText, startedAt, completedAt)
}

func writeToolActivityLog(
	ctx context.Context,
	client *clawless.Client,
	agentCtx *AgentContext,
	model string,
	step int,
	call *ToolCall,
	result *ToolResult,
	outputText string,
	startedAt time.Time,
	completedAt time.Time,
) {
	if client == nil || agentCtx == nil || call == nil {
		return
	}
	if result == nil {
		result = &ToolResult{Success: false, Error: "tool returned nil result"}
	}

	log := buildToolActivityLog(agentCtx, model, step, call, result, outputText, startedAt, completedAt)
	if err := client.WriteToolActivityLogs(ctx, []clawless.ToolActivityLog{log}); err != nil {
		slog.Warn("failed to write tool activity log",
			"tool", call.Name,
			"session", agentCtx.SessionID,
			"error", err,
		)
	}
}

func buildToolActivityLog(
	agentCtx *AgentContext,
	model string,
	step int,
	call *ToolCall,
	result *ToolResult,
	outputText string,
	startedAt time.Time,
	completedAt time.Time,
) clawless.ToolActivityLog {
	action, target, arguments := classifyToolActivity(call.Name, call.Arguments)
	// Snapshot SandboxID under the per-session state lock (nil-safe for
	// detached contexts and for ExecuteTool's execCtx copy, which shares
	// the same lock pointer): sandbox_destroy clears it concurrently.
	sandboxID := agentCtx.SnapshotSandboxID()
	return clawless.ToolActivityLog{
		TaskID:         agentCtx.TaskID,
		SessionID:      agentCtx.SessionID,
		RunID:          agentCtx.RunID,
		AgentID:        agentCtx.AgentID,
		UserID:         agentCtx.UserID,
		Roles:          agentCtx.Roles,
		Source:         agentCtx.Source,
		SandboxID:      sandboxID,
		Model:          model,
		Step:           step,
		ToolCallID:     call.ID,
		IdempotencyKey: buildToolIdempotencyKey(agentCtx.TaskID, call.ID, step, startedAt),
		ToolName:       call.Name,
		Action:         action,
		Target:         target,
		Arguments:      arguments,
		Result:         result,
		OutputText:     outputText,
		Success:        result.Success,
		Error:          result.Error,
		DurationMs:     completedAt.Sub(startedAt).Milliseconds(),
		StartedAt:      startedAt,
		CompletedAt:    completedAt,
	}
}

// buildToolIdempotencyKey derives the idempotency key for a tool
// activity log. When callID is present it is unique per tool call, so
// "task:call" is sufficient. When callID is empty (some providers omit
// tool-call ids) every call in the task would collide on the same key
// and the receiver would deduplicate them away — so fall back to
// step + RFC3339Nano started-at, which is unique per invocation.
func buildToolIdempotencyKey(taskID, callID string, step int, startedAt time.Time) string {
	if callID != "" {
		return "tool:" + taskID + ":" + callID
	}
	return "tool:" + taskID + ":" + strconv.Itoa(step) + ":" + startedAt.UTC().Format(time.RFC3339Nano)
}

func classifyToolActivity(toolName string, args json.RawMessage) (string, string, any) {
	arguments := decodeToolArguments(args)
	argMap, _ := arguments.(map[string]any)

	switch toolName {
	case "read":
		return "read", stringArg(argMap, "path"), arguments
	case "write", "edit", "patch":
		return "write", stringArg(argMap, "path"), arguments
	case "ls", "glob":
		return "read", stringArg(argMap, "path"), arguments
	case "grep":
		target := stringArg(argMap, "path")
		if pattern := stringArg(argMap, "pattern"); pattern != "" {
			if target != "" {
				target += " "
			}
			target += "pattern=" + pattern
		}
		return "search", target, arguments
	case "exec":
		return "execute", stringArg(argMap, "command"), arguments
	case "exec_background":
		return "execute", stringArg(argMap, "command"), arguments
	case "exec_background_status", "exec_background_stop":
		return "execute", stringArg(argMap, "task_id"), arguments
	case "exec_batch":
		return "execute", execBatchTarget(argMap), arguments
	case "git_clone":
		return "execute", stringArg(argMap, "url"), arguments
	case "git_diff", "git_status", "git_push":
		return "execute", stringArg(argMap, "path"), arguments
	case "web_fetch", "web_render":
		return "network", stringArg(argMap, "url"), arguments
	case "web_search", "web_rendered_search", "memory_search", "knowledge_search":
		return "search", firstNonEmptyStringArg(argMap, "query", "q"), arguments
	case "memory_save":
		return "write", stringArg(argMap, "key"), arguments
	case "sandbox_install":
		return "execute", stringArg(argMap, "manager"), arguments
	default:
		if strings.Contains(toolName, "read") || strings.Contains(toolName, "list") {
			return "read", bestEffortTarget(argMap), arguments
		}
		if strings.Contains(toolName, "write") || strings.Contains(toolName, "save") || strings.Contains(toolName, "edit") {
			return "write", bestEffortTarget(argMap), arguments
		}
		if strings.Contains(toolName, "search") || strings.Contains(toolName, "grep") {
			return "search", bestEffortTarget(argMap), arguments
		}
		if strings.Contains(toolName, "exec") || strings.Contains(toolName, "install") || strings.Contains(toolName, "git") {
			return "execute", bestEffortTarget(argMap), arguments
		}
		return "other", bestEffortTarget(argMap), arguments
	}
}

func decodeToolArguments(args json.RawMessage) any {
	if len(args) == 0 {
		return map[string]any{}
	}

	var decoded any
	if err := json.Unmarshal(args, &decoded); err != nil {
		return string(args)
	}
	return decoded
}

func stringArg(args map[string]any, key string) string {
	if args == nil {
		return ""
	}
	value, ok := args[key]
	if !ok {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return typed
	case json.Number:
		return typed.String()
	default:
		return ""
	}
}

func firstNonEmptyStringArg(args map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := stringArg(args, key); value != "" {
			return value
		}
	}
	return ""
}

func execBatchTarget(args map[string]any) string {
	commands, ok := args["commands"].([]any)
	if !ok {
		return ""
	}
	targets := make([]string, 0, len(commands))
	for _, command := range commands {
		cmdMap, ok := command.(map[string]any)
		if !ok {
			continue
		}
		if commandText := stringArg(cmdMap, "command"); commandText != "" {
			targets = append(targets, commandText)
		}
	}
	return strings.Join(targets, "\n")
}

func bestEffortTarget(args map[string]any) string {
	return firstNonEmptyStringArg(args, "path", "command", "url", "query", "key", "task_id", "id")
}
