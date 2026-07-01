package agent

import (
	"context"
	"encoding/json"
	"log/slog"
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

	l.messages = append(l.messages, Message{
		Role:    "tool",
		Content: string(resultJSON),
	})
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

	action, target, arguments := classifyToolActivity(call.Name, call.Arguments)
	log := clawless.ToolActivityLog{
		TaskID:      agentCtx.TaskID,
		SessionID:   agentCtx.SessionID,
		AgentID:     agentCtx.AgentID,
		UserID:      agentCtx.UserID,
		Roles:       agentCtx.Roles,
		Source:      agentCtx.Source,
		SandboxID:   agentCtx.SandboxID,
		Model:       model,
		Step:        step,
		ToolCallID:  call.ID,
		ToolName:    call.Name,
		Action:      action,
		Target:      target,
		Arguments:   arguments,
		Result:      result,
		OutputText:  outputText,
		Success:     result.Success,
		Error:       result.Error,
		DurationMs:  completedAt.Sub(startedAt).Milliseconds(),
		StartedAt:   startedAt,
		CompletedAt: completedAt,
	}

	if err := client.WriteToolActivityLogs(ctx, []clawless.ToolActivityLog{log}); err != nil {
		slog.Warn("failed to write tool activity log",
			"tool", call.Name,
			"session", agentCtx.SessionID,
			"error", err,
		)
	}
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
