package agent

import (
	"fmt"
	"time"
)

// AgentContext holds the runtime context for an agent session.
type AgentContext struct {
	SessionID       string
	AgentID         string
	SandboxID       string
	SandboxType     string
	SandboxPath     string
	Model           string
	MaxSteps        int
	SystemPrompt    string
	StartTime       time.Time
	LastAccessTime  time.Time

	// Injected context for each turn
	SandboxState    SandboxInfo
	SessionSummary  string
	RecentToolCalls []ToolCallRecord
}

// SandboxInfo describes the current sandbox for LLM context injection.
type SandboxInfo struct {
	Type        string `json:"type"`
	Path        string `json:"path"`
	AvailableMB int64  `json:"available_mb"`
}

// ToolCallRecord tracks a recent tool call for LLM context.
type ToolCallRecord struct {
	Tool    string `json:"tool"`
	Args    string `json:"args"`
	Result  string `json:"result"`
	Success bool   `json:"success"`
	Time    time.Time `json:"time"`
}

// BuildSystemPromptContext generates the context injected before each LLM turn.
func (c *AgentContext) BuildSystemPromptContext() string {
	return fmt.Sprintf(
		"## 当前状态\n"+
			"- 沙箱类型: %s\n"+
			"- 沙箱路径: %s\n"+
			"- 会话摘要: %s\n\n"+
			"## 最近工具调用 (最近5次)\n%s\n",
		c.SandboxState.Type,
		c.SandboxState.Path,
		c.SessionSummary,
		formatRecentToolCalls(c.RecentToolCalls),
	)
}

func formatRecentToolCalls(records []ToolCallRecord) string {
	if len(records) == 0 {
		return "(无)"
	}
	result := ""
	for _, r := range records {
		status := "✓"
		if !r.Success {
			status = "✗"
		}
		result += fmt.Sprintf("- %s %s(%s) → %s\n", status, r.Tool, r.Args, truncate(r.Result, 200))
	}
	return result
}


