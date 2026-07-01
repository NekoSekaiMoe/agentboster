package agent

import (
	"fmt"
	"time"

	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/eventbus"
	"github.com/clawless/agentd/internal/persistence"
	"github.com/clawless/agentd/internal/security/l0_rules"
	"github.com/clawless/agentd/internal/worker/workers"
)

// AgentContext holds the runtime context for an agent session.
type AgentContext struct {
	SessionID      string
	TaskID         string
	AgentID        string
	UserID         string
	Roles          []string
	Source         clawless.BotSource
	SandboxID      string
	SandboxType    string
	SandboxPath    string
	Model          string
	MaxSteps       int
	SystemPrompt   string
	StartTime      time.Time
	LastAccessTime time.Time

	// Question service for LLM-initiated questions
	QuestionService *QuestionService

	// Injected context for each turn
	SandboxState    SandboxInfo
	SessionSummary  string
	RecentToolCalls []ToolCallRecord

	// Persistence stores (injected by Manager)
	BGTaskStore *persistence.BackgroundTaskStore

	// Parallel exec infrastructure (injected by Manager/Dispatcher)
	ExecBus       *eventbus.Bus
	ExecCollector *workers.BatchCollector

	// TaskState tracks execution state across compaction boundaries
	TaskState TaskState

	// Delivery info for completion notification (set by deliver_files tool)
	DeliveryURL   string
	DeliveryFiles []string
	DeliverySize  int64

	// Git info for completion notification (set by git_push tool)
	GitInfo *clawless.GitInfo

	// Current project context
	ProjectID   string
	WorkspaceID string

	// SOUL content injected into system prompt
	SoulContent string

	// AgentsMd is the merged AGENTS.md content injected into the system prompt
	// as project-supplied reference data. Loaded by the Manager from
	// <brandHome>/AGENTS.md, <realHome>/.agents/AGENTS.md, and every AGENTS.md
	// from the sandbox path up to the project root. Empty when nothing was
	// found or when the session has no sandbox path. See LoadAgentsMd.
	AgentsMd string
	// AgentsMdWarning is a non-empty user-facing warning when AgentsMd exceeds
	// the recommended size budget. Empty otherwise.
	AgentsMdWarning string

	// P1.2: Agent config fetched from the web layer. Currently used to:
	//   - gate mcp_call tool registration (MCPEnabled)
	//   - pass the MCP server allowlist to the mcp_call tool
	//   - inform MaxParallelSubAgents (P0.1 already wires the default)
	// Nil = use daemon defaults. Set by Manager before registering tools.
	AgentConfig *clawless.AgentConfig

	// L0Engine enables tool-layer output auditing. Currently only
	// browser_evaluate consults it (to block prompt/credential leakage
	// through arbitrary in-page JS execution). The loop-level
	// Gatekeeper.AuditOutput path is independent and always runs.
	// Nil = no tool-layer L0 auditing (e.g. in tests).
	L0Engine *l0_rules.Engine
}

// TaskState holds execution state that survives context compaction.
type TaskState struct {
	SandboxType       string            `json:"sandbox_type"`
	SandboxID         string            `json:"sandbox_id"`
	L2AuthRecords     []string          `json:"l2_auth_records"`
	SubAgentProgress  map[string]string `json:"sub_agent_progress"`
	SubAgentSummaries []SubAgentSummary `json:"sub_agent_summaries"`
	SubAgentStates    map[string]string `json:"sub_agent_states"` // subagent ID → state file path
	KeyDecisions      []string          `json:"key_decisions"`
	LastToolSummary   string            `json:"last_tool_summary"`
	CompactedAt       string            `json:"compacted_at,omitempty"`
	CompactionCount   int               `json:"compaction_count"`
}

// SubAgentSummary stores a summarized result from a completed sub-agent.
type SubAgentSummary struct {
	ID        string `json:"id"`
	Task      string `json:"task"`
	Summary   string `json:"summary"`
	Success   bool   `json:"success"`
	CreatedAt string `json:"created_at"`
}

// SandboxInfo describes the current sandbox for LLM context injection.
type SandboxInfo struct {
	Type        string `json:"type"`
	Path        string `json:"path"`
	AvailableMB int64  `json:"available_mb"`
}

// ToolCallRecord tracks a recent tool call for LLM context.
type ToolCallRecord struct {
	Tool    string    `json:"tool"`
	Args    string    `json:"args"`
	Result  string    `json:"result"`
	Success bool      `json:"success"`
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
