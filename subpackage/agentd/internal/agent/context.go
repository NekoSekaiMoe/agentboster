package agent

import (
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/eventbus"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/persistence"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/security/l0_rules"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/worker/workers"
)

// AgentContext holds the runtime context for an agent session.
type AgentContext struct {
	SessionID string
	TaskID    string
	AgentID   string
	UserID    string
	Roles     []string
	Source    clawless.BotSource
	// RunID is the Web-tier workflow run id propagated from
	// ToolExecRequest.RunID for cross-tier tracing. Copied onto any
	// clawless.Task built during tool execution so callbacks to the
	// Web carry the originating run id. Empty for non-traced paths.
	RunID          string
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

	// stateLock is the per-session state lock, owned by the Manager's
	// sessionLocks registry (see manager.go). It serializes every write
	// to the mutable fields above (SoulContent/AgentConfig/SystemPrompt/
	// AgentsMd/SessionSummary/RecentToolCalls/TaskState/LastAccessTime/
	// Delivery*/GitInfo/Sandbox* post-creation) against concurrent
	// readers (status endpoints, session serialization, HTTP handlers
	// reading SandboxID) and against ExecuteTool's shallow copy.
	//
	// It is a POINTER to an external mutex — deliberately NOT an embedded
	// sync.Mutex — so ExecuteTool's `execCtx := *agentCtx` shallow copy
	// stays `go vet` copylocks-clean while still sharing the same
	// underlying lock as the shared session struct.
	//
	// Nil for detached contexts (sub-agent contexts, store-loaded
	// snapshots, test fixtures): those are single-goroutine-owned, so
	// WithStateLock degrades to a no-op. Always access via WithStateLock;
	// never dereference directly.
	stateLock *sync.Mutex
}

// Log returns the request-scoped logger for this execution context.
// When RunID is set (the Web-tier workflow run id propagated from
// ToolExecRequest.RunID) the logger carries a run_id attribute, so
// every slog line emitted while the task executes — manager warnings,
// loop step lines, sub-agent lifecycle logs — can be grepped across
// runLogger is the shared rule for deriving a run-scoped logger used by
// both AgentContext.Log and subagentParentSnapshot.log: slog.Default()
// when the run id is empty (legacy callers see no log-shape change),
// otherwise a logger carrying run_id. Factored out so the two callers
// cannot diverge.
func runLogger(runID string) *slog.Logger {
	if runID == "" {
		return slog.Default()
	}
	return slog.With("run_id", runID)
}

// both tiers by one id. When RunID is empty (legacy callers that don't
// pass a run id) it returns slog.Default(), preserving the pre-tracing
// log shape exactly.
func (c *AgentContext) Log() *slog.Logger {
	if c == nil {
		return slog.Default()
	}
	return runLogger(c.RunID)
}

// WithStateLock runs fn under the per-session state lock (nil-safe:
// detached contexts run fn directly). Writers of shared mutable
// AgentContext fields and readers racing those writers must use this.
//
// Lock ordering (acyclic): Manager.mu → Manager.sessionLocksMu →
// AgentContext.stateLock. Never acquire Manager.mu (or any Manager
// lock) from inside fn.
//
// NON-REENTRANT: the underlying sync.Mutex is not reentrant, so
// calling WithStateLock again from inside fn — including indirectly,
// e.g. via a shallow-copied context that shares the same stateLock
// pointer (ExecuteTool's execCtx copy), or via a helper that itself
// takes the lock — will self-deadlock. Never nest WithStateLock calls;
// if a second critical section is needed, run it AFTER the first one
// returns.
func (c *AgentContext) WithStateLock(fn func()) {
	if c.stateLock == nil {
		fn()
		return
	}
	c.stateLock.Lock()
	defer c.stateLock.Unlock()
	fn()
}

// SnapshotSandboxID returns ctx.SandboxID read under the per-session
// state lock (nil-safe: detached contexts read directly). Tool handlers
// and manager/server paths that hold a potentially SHARED session
// context must use this instead of reading ctx.SandboxID directly —
// tools_sandbox_destroy clears the field under the same lock, so an
// unlocked read races with it. The execution-local copy inside
// ExecuteTool's own body (below the shallow copy) may still read the
// field directly, since only that goroutine mutates the copy.
//
// Do NOT call this from inside a WithStateLock fn — the lock is
// non-reentrant (see WithStateLock).
func (c *AgentContext) SnapshotSandboxID() string {
	var id string
	c.WithStateLock(func() { id = c.SandboxID })
	return id
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
