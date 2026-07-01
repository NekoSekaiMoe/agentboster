package agent

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
	"github.com/google/uuid"
)

// DefaultMaxParallelSubagents is the default cap on concurrent sub-agent
// goroutines per daemon. Can be overridden per-agent via AgentConfig
// (MaxParallelSubAgents) once that field is wired (P1.1).
const DefaultMaxParallelSubagents = 3

// SubagentLauncher is the contract the Manager implements to actually run
// a sub-agent's AgentLoop in an isolated sandbox. Kept as an interface so
// the subagent tool can be unit-tested with a fake.
type SubagentLauncher interface {
	// LaunchSubagent starts a sub-agent in a new goroutine and returns
	// immediately with the sub-agent ID. Completion (or failure) is
	// reported via StoreSubagentResult, after which the result is
	// retrievable via the registry.
	LaunchSubagent(parent *AgentContext, req SubagentRequest) string
}

// SubagentRequest carries everything needed to start a sub-agent.
type SubagentRequest struct {
	ID             string   // pre-generated UUID
	Task           string   // concrete task description
	Context        string   // relevant context fragment (NOT full history)
	ExpectedOutput string   // desired shape of the result
	SystemPrompt   string   // already-substituted isolated system prompt
	SandboxType    string   // "auto" lets manager pick
	FileBoundaries []string // glob patterns enforced by L0
	ParentSandbox  string   // parent sandbox path (for state file location)
}

// subagentRunner is the package-level injection point set by Manager at
// startup. Tools call LaunchSubagent through this pointer; if nil, the
// subagent tool reports an explicit error rather than silently doing
// nothing (which is the bug P0.1 fixes).
var (
	subagentRunner SubagentLauncher
	subagentSemMu  sync.Mutex
	subagentSem    = make(chan struct{}, DefaultMaxParallelSubagents)
)

// SetSubagentLauncher wires the launcher (called by Manager.SetBus or
// explicitly by lifecycle).
func SetSubagentLauncher(l SubagentLauncher) {
	subagentRunner = l
}

// SetMaxParallelSubagents resizes the concurrency limiter. Safe to call
// at runtime; in-flight tokens from the previous semaphore are honored
// because we replace the channel — old goroutines release into the old
// channel, new acquires hit the new one. Intended to be called once at
// startup per agent config (P1.1).
func SetMaxParallelSubagents(n int) {
	if n <= 0 {
		n = DefaultMaxParallelSubagents
	}
	subagentSemMu.Lock()
	subagentSem = make(chan struct{}, n)
	subagentSemMu.Unlock()
}

// acquireSubagentSlot blocks until a concurrency slot is available or
// ctx is cancelled.
func acquireSubagentSlot(ctx context.Context) error {
	subagentSemMu.Lock()
	sem := subagentSem
	subagentSemMu.Unlock()
	select {
	case sem <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func releaseSubagentSlot() {
	subagentSemMu.Lock()
	sem := subagentSem
	subagentSemMu.Unlock()
	select {
	case <-sem:
	default:
		// Should not happen; defensive only.
		slog.Warn("subagent semaphore released with no token held")
	}
}

// LaunchSubagent implements SubagentLauncher on *Manager.
// It generates the sub-agent ID, registers the task, persists state for
// crash recovery, and spawns a goroutine that runs the isolated
// AgentLoop. The goroutine writes its result back into the registry via
// StoreSubagentResult, so callers of subagent_result observe completion.
func (m *Manager) LaunchSubagent(parent *AgentContext, req SubagentRequest) string {
	if req.ID == "" {
		req.ID = uuid.NewString()
	}

	subTask := &clawless.Task{
		ID:           req.ID,
		AgentID:      parent.AgentID,
		SessionID:    parent.SessionID,
		Command:      req.Task,
		SandboxType:  req.SandboxType,
		SystemPrompt: req.SystemPrompt,
		Status:       clawless.TaskRunning,
	}

	subagentRegistry.mu.Lock()
	subagentRegistry.agents[req.ID] = subTask
	subagentRegistry.mu.Unlock()

	// Save state file for crash recovery (path is also persisted in
	// parent TaskState by the tool handler).
	statePath := ""
	if req.ParentSandbox != "" {
		statePath = saveSubagentState(
			req.ParentSandbox, req.ID, req.Task, req.Context,
			parent.SessionID, parent.SandboxID, parent.SandboxType,
		)
	}

	// Snapshot the fields the goroutine needs; do NOT capture `parent`
	// directly — the parent AgentContext is a shared pointer whose
	// fields (RecentToolCalls, TaskState, SessionSummary) mutate as the
	// parent loop continues. We only need a few immutable identifiers.
	parentSnap := subagentParentSnapshot{
		agentID:        parent.AgentID,
		sessionID:      parent.SessionID,
		userID:         parent.UserID,
		roles:          append([]string(nil), parent.Roles...),
		source:         parent.Source,
		parentSandbox:  req.ParentSandbox,
		systemPrompt:   req.SystemPrompt,
		task:           req.Task,
		expectedOutput: req.ExpectedOutput,
		sandboxType:    req.SandboxType,
		statePath:      statePath,
		subagentID:     req.ID,
	}

	slog.Info("subagent launched",
		"subagent_id", req.ID,
		"task", req.Task,
		"sandbox_type", req.SandboxType,
		"state_path", statePath,
	)

	go m.runSubagentLoop(parentSnap)

	return req.ID
}

// subagentParentSnapshot is an immutable snapshot of the parent context
// fields the sub-agent goroutine needs. Avoids races with the parent
// loop mutating the shared *AgentContext.
type subagentParentSnapshot struct {
	agentID        string
	sessionID      string
	userID         string
	roles          []string
	source         clawless.BotSource
	parentSandbox  string
	systemPrompt   string
	task           string
	expectedOutput string
	sandboxType    string
	statePath      string
	subagentID     string
}

// runSubagentLoop is the goroutine body. It acquires a concurrency slot,
// builds an isolated AgentContext + sandbox + tool registry, runs the
// loop, summarizes the result, stores it, and updates the state file.
// Panics are recovered and surfaced as a failed result so the parent
// agent sees an error instead of an eternal "running".
func (m *Manager) runSubagentLoop(snap subagentParentSnapshot) {
	// Recovery: always release the slot and record a result so the
	// parent never observes a zombie "running" state forever.
	resultStored := false
	storeFinal := func(rawResult, summary, errMsg string) {
		if resultStored {
			return
		}
		resultStored = true
		if errMsg != "" {
			rawResult = fmt.Sprintf("[subagent failed] %s\n\nPartial output:\n%s", errMsg, truncate(rawResult, 1000))
			summary = rawResult
		}
		StoreSubagentResult(snap.subagentID, rawResult, summary)
		if snap.parentSandbox != "" {
			updateSubagentState(snap.parentSandbox, snap.subagentID, 0, "completed")
		}
		// Update task status in registry.
		subagentRegistry.mu.Lock()
		if t, ok := subagentRegistry.agents[snap.subagentID]; ok {
			t.Status = clawless.TaskCompleted
			t.Result = summary
		}
		subagentRegistry.mu.Unlock()
	}

	defer func() {
		if r := recover(); r != nil {
			slog.Error("subagent panicked",
				"subagent_id", snap.subagentID,
				"panic", r,
			)
			storeFinal("", "", fmt.Sprintf("internal panic: %v", r))
		}
		releaseSubagentSlot()
	}()

	// Acquire concurrency slot (bounded by semaphore). Use a generous
	// timeout so a stuck semaphore doesn't permanently deadlock the
	// subagent; the parent's tool call will already have returned, so
	// this only affects when the subagent actually starts.
	slotCtx, slotCancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer slotCancel()
	if err := acquireSubagentSlot(slotCtx); err != nil {
		storeFinal("", "", fmt.Sprintf("could not acquire subagent slot: %v", err))
		return
	}

	// Build a sub-agent sandbox. Use Manager's sandbox picker so the
	// same auto-selection logic (high-risk → docker-strict, persistence
	// → lxc) applies.
	sbType := snap.sandboxType
	if sbType == "" || sbType == "auto" {
		// Reuse the sandbox manager's risk heuristics.
		sbType = sandbox.SelectSandbox(&clawless.Task{
			Command:     snap.task,
			SandboxType: snap.sandboxType,
		}, nil)
	}
	sbSpec := sandbox.SandboxSpec{
		Type:    sbType,
		AgentID: snap.agentID,
	}
	sb, err := m.sbManager.CreateSandbox(sbSpec)
	if err != nil {
		storeFinal("", "", fmt.Sprintf("create subagent sandbox (%s): %v", sbType, err))
		return
	}
	defer func() {
		if err := m.sbManager.DestroySandbox(sb.ID); err != nil {
			slog.Warn("failed to destroy subagent sandbox",
				"subagent_id", snap.subagentID, "sandbox_id", sb.ID, "error", err)
		}
	}()

	now := time.Now()
	subCtx := &AgentContext{
		SessionID:      snap.sessionID + "::sub::" + snap.subagentID,
		TaskID:         snap.subagentID,
		AgentID:        snap.agentID,
		UserID:         snap.userID,
		Roles:          snap.roles,
		Source:         snap.source,
		SandboxID:      sb.ID,
		SandboxType:    sb.Type,
		SandboxPath:    sb.Path,
		MaxSteps:       30,
		StartTime:      now,
		LastAccessTime: now,
		SandboxState:   SandboxInfo{Type: sb.Type, Path: sb.Path},
		SystemPrompt:   snap.systemPrompt,
		// Sub-agents do NOT inherit the parent's RecentToolCalls,
		// SessionSummary, or TaskState — they start with a clean slate
		// by design (the whole point of sub-agents is context isolation).
		RecentToolCalls: make([]ToolCallRecord, 0),
		QuestionService: m.questionSvc,
		BGTaskStore:     m.bgTaskStore,
		ExecBus:         m.bus,
		ExecCollector:   m.execCollector,
		// Sub-agent inherits the parent's AgentConfig (for MCP enablement
		// and per-agent resource limits). Fetched lazily; if the parent
		// didn't have one, the sub-agent doesn't either.
		AgentConfig: m.fetchAgentConfig(context.Background(), snap.agentID),
	}
	m.wireSessionRuntime(subCtx)

	// Register tools for the sub-agent. Sub-agents do NOT get the
	// `subagent` or `subagent_result` tools (no recursive nesting);
	// everything else is available.
	registry := NewToolRegistry(append([]string(nil), m.disabledTools...))
	registerSubagentToolset(registry, m.sbManager, m.clawless, subCtx)

	loop := NewAgentLoop(
		registry,
		subCtx,
		m.clawless,
		m.llmEndpoint,
		m.llmModel,
		m.llmAPIKey,
		m.l1Scorer,
		m.gatekeeper,
	)

	// Bound the sub-agent's wall-clock time so a runaway loop can't
	// hold a slot forever. 15 minutes is the hard cap; the loop's own
	// MaxSteps=30 is the primary bound.
	runCtx, runCancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer runCancel()

	slog.Info("subagent loop starting",
		"subagent_id", snap.subagentID,
		"task", snap.task,
		"sandbox_id", sb.ID,
		"sandbox_type", sb.Type,
	)

	rawResult, runErr := loop.Run(runCtx, snap.task)
	if runErr != nil {
		storeFinal(rawResult, "", runErr.Error())
		return
	}

	// Summarize via the LLM proxy (falls back to truncated raw on error).
	summary, summarizeErr := SummarizeSubagentResult(
		context.Background(), m.clawless, m.llmModel,
		snap.subagentID, snap.task, rawResult,
	)
	if summarizeErr != nil {
		slog.Warn("subagent summarize failed; using truncated raw",
			"subagent_id", snap.subagentID, "error", summarizeErr)
		summary = truncate(rawResult, 1000)
	}

	slog.Info("subagent completed",
		"subagent_id", snap.subagentID,
		"raw_len", len(rawResult),
		"summary_len", len(summary),
	)

	storeFinal(rawResult, summary, "")
}

// registerSubagentToolset registers the full tool set EXCEPT the
// subagent/subagent_result tools (no recursion). This mirrors
// RegisterAllTools but skips the two sub-agent entries.
func registerSubagentToolset(
	registry *ToolRegistry,
	sbManager *sandbox.Manager,
	clawlessClient *clawless.Client,
	agentCtx *AgentContext,
) {
	// Sandbox execution
	registerExec(registry, sbManager, agentCtx)
	registerExecBackground(registry, sbManager, agentCtx)
	registerExecBatch(registry, sbManager, agentCtx)

	// File operations
	registerRead(registry, sbManager, agentCtx)
	registerWrite(registry, sbManager, agentCtx)
	registerEdit(registry, sbManager, agentCtx)
	registerLs(registry, sbManager, agentCtx)
	registerGrep(registry, sbManager, agentCtx)
	registerGlob(registry, sbManager, agentCtx)
	registerPatch(registry, sbManager, agentCtx)

	// Web
	registerWebFetch(registry)
	registerWebSearch(registry)
	registerWebRendered(registry, sbManager, agentCtx)

	// Git
	registerGitClone(registry, sbManager, agentCtx)
	registerGitDiff(registry, sbManager, agentCtx)
	registerGitStatus(registry, sbManager, agentCtx)
	registerGitPush(registry, sbManager, clawlessClient, agentCtx)

	// Memory
	registerMemorySearch(registry, clawlessClient, agentCtx)
	registerMemorySave(registry, clawlessClient, agentCtx)

	// Knowledge
	registerKnowledgeSearch(registry, clawlessClient, agentCtx)

	// Vault
	registerVaultList(registry, clawlessClient)

	// Task summary
	registerTaskSummary(registry, clawlessClient, agentCtx)
	registerTaskProgress(registry, clawlessClient, agentCtx)

	// Delivery
	registerDeliverFiles(registry, sbManager, clawlessClient, agentCtx)

	// Sandbox install
	registerSandboxInstall(registry, sbManager, agentCtx)

	// Ask question (sub-agent can ask too — routes to same user)
	registerAskQuestion(registry, agentCtx)

	// Skills & media
	registerSandboxSkills(registry, sbManager, agentCtx)
	registerSandboxMedia(registry, sbManager, agentCtx)

	// CodeAct
	registerCodeAct(registry, sbManager, clawlessClient, agentCtx)

	// Browser automation (P2: tools_browser_v2)
	registerBrowserToolsV2(registry, sbManager, agentCtx)

	// MCP bridge (gated by agent config, same as parent).
	if agentCtx.AgentConfig != nil && agentCtx.AgentConfig.MCPEnabled {
		registerMCPCall(registry, clawlessClient, agentCtx, agentCtx.AgentConfig.MCPServers)
	}

	// DELIBERATELY OMITTED: registerSubagent, registerSubagentResult
	// (no recursive sub-agent nesting).
}
