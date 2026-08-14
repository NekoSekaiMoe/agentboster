package worker

import (
	"bytes"
	"context"
	crand "crypto/rand"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/agent"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/config"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/eventbus"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/security"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/security/l2_auth"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/worker/workers"
)

// Dispatcher routes events from the bus to the appropriate worker pools.
type Dispatcher struct {
	bus                 *eventbus.Bus
	taskPool            *Pool
	reviewPool          *Pool
	sandboxPool         *Pool
	memoryPool          *Pool
	cleanupPool         *Pool
	execPool            *Pool
	gatekeeper          *security.Gatekeeper
	sbManager           *sandbox.Manager
	clawless            *clawless.Client
	agentManager        *agent.Manager
	l2Mgr               *l2_auth.L2AuthManager
	tidyInterval        time.Duration
	tidyStop            chan struct{}
	execCollector       *workers.BatchCollector
	execCollectorCancel context.CancelFunc

	// nodeID is this daemon's stable node identifier (identity.Resolve).
	// Attached to L2 authorization notifications so the Web layer can
	// pin the pending decision to *this* node and route the user's
	// verdict back here — not to nodes[0]. Empty is tolerated (older
	// single-node installs); the Web side falls back to default URL
	// resolution when node_id is absent.
	nodeID string

	// P1.1: per-agent config cache (5-minute TTL). Keyed by agentID.
	// Empty agentID ("") falls through to a synthetic default config.
	agentCfgMu sync.RWMutex
	agentCfg   map[string]*agentCfgEntry
}

// agentCfgEntry is a single cached AgentConfig lookup.
type agentCfgEntry struct {
	cfg       *clawless.AgentConfig
	fetchedAt time.Time
}

// agentCfgTTL is how long a cached AgentConfig entry is considered fresh.
const agentCfgTTL = 5 * time.Minute

// NewDispatcher creates a dispatcher with all worker pools and dependencies.
func NewDispatcher(
	bus *eventbus.Bus,
	poolCfg config.WorkerPoolConfig,
	execPoolCfg config.ExecPoolConfig,
	gk *security.Gatekeeper,
	sbManager *sandbox.Manager,
	clawlessClient *clawless.Client,
	agentManager *agent.Manager,
	l2Mgr *l2_auth.L2AuthManager,
	tidyInterval time.Duration,
	nodeID string,
) *Dispatcher {
	collector := workers.NewBatchCollector(bus, 0)
	d := &Dispatcher{
		bus:           bus,
		taskPool:      NewPool("task", poolCfg),
		reviewPool:    NewPool("review", poolCfg),
		sandboxPool:   NewPool("sandbox", poolCfg),
		memoryPool:    NewPool("memory", poolCfg),
		cleanupPool:   NewPool("cleanup", poolCfg),
		execPool:      NewPool("exec", workerPoolFromExecPool(execPoolCfg)),
		gatekeeper:    gk,
		sbManager:     sbManager,
		clawless:      clawlessClient,
		agentManager:  agentManager,
		l2Mgr:         l2Mgr,
		nodeID:        nodeID,
		tidyInterval:  tidyInterval,
		tidyStop:      make(chan struct{}),
		execCollector: collector,
		agentCfg:      make(map[string]*agentCfgEntry),
	}
	agentManager.SetExecCollector(collector)
	d.registerRoutes()
	return d
}

// getAgentConfig returns the cached AgentConfig for the given agentID,
// fetching from the web layer on miss or when the TTL has expired.
//
// P1.1: Previously the dispatcher passed nil to SelectSandbox, so the
// agent-default sandbox selector was never honored. Now we cache the
// per-agent config for 5 minutes and surface it to SelectSandbox and
// SandboxSpec construction.
//
// Failures (network, 404) return nil — callers treat nil as "use
// defaults" and continue. The cache stays empty so the next call retries.
func (d *Dispatcher) getAgentConfig(ctx context.Context, agentID string) *clawless.AgentConfig {
	if agentID == "" || d.clawless == nil {
		return nil
	}

	d.agentCfgMu.RLock()
	if entry, ok := d.agentCfg[agentID]; ok && time.Since(entry.fetchedAt) < agentCfgTTL {
		d.agentCfgMu.RUnlock()
		return entry.cfg
	}
	d.agentCfgMu.RUnlock()

	fetchCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cfg, err := d.clawless.GetAgentConfig(fetchCtx, agentID)
	if err != nil {
		slog.Debug("agent-config fetch failed; using defaults",
			"agent_id", agentID, "error", err)
		return nil
	}

	d.agentCfgMu.Lock()
	d.agentCfg[agentID] = &agentCfgEntry{cfg: cfg, fetchedAt: time.Now()}
	d.agentCfgMu.Unlock()
	return cfg
}

func workerPoolFromExecPool(cfg config.ExecPoolConfig) config.WorkerPoolConfig {
	return config.WorkerPoolConfig{
		MinWorkers:    cfg.MinWorkers,
		MaxWorkers:    cfg.MaxWorkers,
		ScaleUpPct:    cfg.ScaleUpPct,
		ScaleDownPct:  cfg.ScaleDownPct,
		CooldownSecs:  cfg.CooldownSecs,
		StatsInterval: cfg.StatsInterval,
	}
}

// Start launches the tidy ticker and exec batch collector (pools auto-start in NewPool).
func (d *Dispatcher) Start() {
	collectorCtx, collectorCancel := context.WithCancel(context.Background())
	d.execCollectorCancel = collectorCancel
	if err := d.execCollector.Start(collectorCtx); err != nil {
		slog.Warn("exec batch collector failed to start", "error", err)
	}
	d.startTidyTicker()
}

// Stop gracefully shuts down all pools and the tidy ticker.
func (d *Dispatcher) Stop() {
	close(d.tidyStop)
	if d.execCollectorCancel != nil {
		d.execCollectorCancel()
	}
	d.taskPool.Stop()
	d.reviewPool.Stop()
	d.sandboxPool.Stop()
	d.memoryPool.Stop()
	d.cleanupPool.Stop()
	d.execPool.Stop()
}

// Metrics returns aggregated metrics from all worker pools.
func (d *Dispatcher) Metrics() map[string]any {
	return map[string]any{
		"task":    d.taskPool.Metrics(),
		"review":  d.reviewPool.Metrics(),
		"sandbox": d.sandboxPool.Metrics(),
		"memory":  d.memoryPool.Metrics(),
		"cleanup": d.cleanupPool.Metrics(),
		"exec":    d.execPool.Metrics(),
	}
}

func (d *Dispatcher) startTidyTicker() {
	if d.tidyInterval <= 0 {
		return
	}
	ticker := time.NewTicker(d.tidyInterval)
	go func() {
		for {
			select {
			case <-ticker.C:
				d.bus.Publish(eventbus.EventTaskTidyTick, []string{})
			case <-d.tidyStop:
				ticker.Stop()
				return
			}
		}
	}()
	slog.Info("tidy ticker started", "interval", d.tidyInterval)
}

func (d *Dispatcher) registerRoutes() {
	d.bus.Subscribe(eventbus.EventTaskCreated, func(e eventbus.Event) {
		d.reviewPool.Submit(func() { d.handleTaskCreated(e) })
	})
	d.bus.Subscribe(eventbus.EventTaskApproved, func(e eventbus.Event) {
		d.taskPool.Submit(func() { d.handleTaskApproved(e) })
	})
	d.bus.Subscribe(eventbus.EventTaskCompleted, func(e eventbus.Event) {
		d.memoryPool.Submit(func() { d.handleTaskCompleted(e) })
	})
	d.bus.Subscribe(eventbus.EventSandboxCreated, func(e eventbus.Event) {
		d.sandboxPool.Submit(func() { d.handleSandboxEvent(e) })
	})
	d.bus.Subscribe(eventbus.EventSandboxDestroyed, func(e eventbus.Event) {
		d.cleanupPool.Submit(func() { d.handleSandboxEvent(e) })
	})
	d.bus.Subscribe(eventbus.EventSecurityAlert, func(e eventbus.Event) {
		d.reviewPool.Submit(func() { d.handleSecurityAlert(e) })
	})
	d.bus.Subscribe(eventbus.EventL2AuthApproved, func(e eventbus.Event) {
		d.reviewPool.Submit(func() { d.handleL2Auth(e) })
	})
	d.bus.Subscribe(eventbus.EventL2AuthRequired, func(e eventbus.Event) {
		d.reviewPool.Submit(func() { d.handleL2AuthRequired(e) })
	})
	d.bus.Subscribe(eventbus.EventL2AuthRejected, func(e eventbus.Event) {
		d.reviewPool.Submit(func() {
			d.handleL2Auth(e)
			d.bus.Publish(eventbus.EventTaskRejected, e.Payload)
		})
	})
	d.bus.Subscribe(eventbus.EventSessionClosed, func(e eventbus.Event) {
		d.cleanupPool.Submit(func() { d.handleSessionClosed(e) })
	})
	d.bus.Subscribe(eventbus.EventSessionArchived, func(e eventbus.Event) {
		d.cleanupPool.Submit(func() { d.handleSessionArchived(e) })
	})
	d.bus.Subscribe(eventbus.EventTaskTidyTick, func(e eventbus.Event) {
		d.memoryPool.Submit(func() { d.handleTaskTidyTick(e) })
	})
	d.bus.Subscribe(eventbus.EventExecRequested, func(e eventbus.Event) {
		d.execPool.Submit(func() {
			workers.HandleExecCommand(context.Background(), e, d.bus)
		})
	})
}

func (d *Dispatcher) handleTaskCreated(e eventbus.Event) {
	task, ok := e.Payload.(*clawless.Task)
	if !ok {
		slog.Error("dispatch: invalid task payload", "type", e.Type)
		return
	}

	slog.Info("dispatch: task created, running Gatekeeper audit", "task_id", task.ID)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	result, logs := d.gatekeeper.Audit(ctx, task, "")

	if len(logs) > 0 && task.RunID != "" {
		if err := d.clawless.WriteReviewLogs(ctx, logs); err != nil {
			slog.Error("failed to write review logs", "task_id", task.ID, "error", err)
		}
	}

	switch result.Decision {
	case security.DecisionAllowed:
		slog.Info("Gatekeeper: allowed", "task_id", task.ID, "reason", result.Reason)
		d.bus.Publish(eventbus.EventTaskApproved, task)
	case security.DecisionBlocked:
		slog.Warn("Gatekeeper: blocked", "task_id", task.ID, "reason", result.Reason)
		d.bus.Publish(eventbus.EventTaskRejected, task)
	case security.DecisionPendingConfirm:
		slog.Warn("Gatekeeper: pending L2 confirmation", "task_id", task.ID, "reason", result.Reason)
	}
}

func (d *Dispatcher) handleTaskApproved(e eventbus.Event) {
	task, ok := e.Payload.(*clawless.Task)
	if !ok {
		slog.Error("dispatch: invalid task payload", "type", e.Type)
		return
	}

	slog.Info("dispatch: task approved, running agent loop", "task_id", task.ID)

	// Create agent session
	agentCtx, err := d.agentManager.CreateSession(task.SessionID, task.AgentID)
	if err != nil {
		slog.Error("agent session creation failed", "task_id", task.ID, "error", err)
		d.bus.Publish(eventbus.EventTaskFailed, task)
		return
	}
	agentCtx.TaskID = task.ID
	agentCtx.UserID = task.UserID
	agentCtx.Roles = task.Roles
	agentCtx.Source = task.Source

	// Set sandbox info — use SelectSandbox for auto-selection
	agentCtx.SandboxID = task.SandboxID
	if agentCtx.SandboxID == "" {
		// P1.1: fetch per-agent config so SelectSandbox honors the
		// agent's default sandbox preference and resource overrides.
		agentCfg := d.getAgentConfig(context.Background(), task.AgentID)
		sbType := sandbox.SelectSandbox(task, agentCfg)
		sbSpec := sandbox.SandboxSpec{
			Type:    sbType,
			AgentID: task.AgentID,
		}
		sandbox.ApplyAgentConfigToSpec(&sbSpec, agentCfg)
		sb, err := d.sbManager.CreateSandbox(sbSpec)
		if err != nil {
			slog.Error("sandbox creation failed", "task_id", task.ID, "error", err)
			d.bus.Publish(eventbus.EventTaskFailed, task)
			return
		}
		agentCtx.SandboxID = sb.ID
		agentCtx.SandboxType = sb.Type
		agentCtx.SandboxPath = sb.Path
		task.SandboxID = sb.ID
	}

	// Create workspace for this task (project-level organization unit)
	wsCtx, wsCancel := context.WithTimeout(context.Background(), 30*time.Second)
	ws, err := d.createWorkspace(wsCtx, task, agentCtx.SandboxID)
	wsCancel()
	if err != nil {
		slog.Warn("workspace creation failed, continuing without workspace", "task_id", task.ID, "error", err)
	} else {
		agentCtx.WorkspaceID = ws.ID
		agentCtx.ProjectID = ws.ProjectID
		slog.Info("workspace created", "task_id", task.ID, "project_id", ws.ProjectID)
	}

	d.bus.Publish(eventbus.EventSandboxCreated, &sandbox.Sandbox{
		ID: agentCtx.SandboxID, Type: agentCtx.SandboxType, Path: agentCtx.SandboxPath,
	})

	// Run agent loop
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	result, err := d.agentManager.RunAgent(ctx, task.SessionID, task.Command)
	if err != nil {
		slog.Error("agent loop failed", "task_id", task.ID, "error", err)
		task.Result = fmt.Sprintf("Agent error: %v", err)
		d.bus.Publish(eventbus.EventTaskFailed, task)
		return
	}

	task.Result = result
	slog.Info("agent loop completed", "task_id", task.ID)
	d.bus.Publish(eventbus.EventTaskCompleted, task)
}

// createWorkspace creates a workspace for the task via ClawLess API.
func (d *Dispatcher) createWorkspace(ctx context.Context, task *clawless.Task, sandboxID string) (*clawless.ProjectSandbox, error) {
	projectID := generateProjectID()
	// P1.1: pass agent config so workspace sandbox type matches the
	// agent's actual selection (was previously a fresh nil-cfg pick).
	agentCfg := d.getAgentConfig(ctx, task.AgentID)
	sbType := sandbox.SelectSandbox(task, agentCfg)
	ws := &clawless.ProjectSandbox{
		ProjectID:   projectID,
		AgentID:     task.AgentID,
		SandboxID:   sandboxID,
		SandboxType: sbType,
		Status:      "active",
	}
	if err := d.clawless.CreateProjectSandbox(ctx, ws); err != nil {
		return nil, err
	}
	return ws, nil
}

// generateProjectID generates a short project identifier like "proj-abc123".
func generateProjectID() string {
	const charset = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 6)
	if _, err := crand.Read(b); err != nil {
		panic(fmt.Sprintf("failed to generate random bytes: %v", err))
	}
	for i := range b {
		b[i] = charset[b[i]%byte(len(charset))]
	}
	return "proj-" + string(b)
}

func (d *Dispatcher) handleTaskCompleted(e eventbus.Event) {
	task, ok := e.Payload.(*clawless.Task)
	if !ok {
		slog.Error("dispatch: invalid task payload", "type", e.Type)
		return
	}

	slog.Info("dispatch: task completed", "task_id", task.ID)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if err := d.clawless.ExtractTaskMemory(ctx, task.ID, clawless.TaskMemoryRequest{
		Status:    string(task.Status),
		Result:    task.Result,
		SessionID: task.SessionID,
		AgentID:   task.AgentID,
		Command:   task.Command,
		UserID:    task.UserID,
	}); err != nil {
		slog.Warn("task memory extraction failed", "task_id", task.ID, "error", err)
	}

	// Send completion notification via ClawLess API
	d.sendCompletionNotification(ctx, task)
}

func (d *Dispatcher) handleTaskTidyTick(e eventbus.Event) {
	slog.Info("dispatch: task tidy tick")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	if err := workers.RunTaskTidy(ctx, d.clawless); err != nil {
		slog.Warn("task tidy failed", "error", err)
	}
}

func (d *Dispatcher) sendCompletionNotification(ctx context.Context, task *clawless.Task) {
	status := "completed"
	if task.Status == "failed" {
		status = "failed"
	} else if task.Status == "cancelled" {
		status = "cancelled"
	}

	details := map[string]any{}

	// Collect delivery info from agent context
	if agentCtx, ok := d.agentManager.GetSession(task.SessionID); ok {
		if agentCtx.DeliveryURL != "" {
			details["download_url"] = agentCtx.DeliveryURL
			details["download_files"] = agentCtx.DeliveryFiles
		}
		if agentCtx.GitInfo != nil {
			details["git_commit_hash"] = agentCtx.GitInfo.CommitHash
			details["git_commit_message"] = agentCtx.GitInfo.CommitMessage
			details["git_compare_url"] = agentCtx.GitInfo.CompareURL
			details["files_changed"] = agentCtx.GitInfo.FilesChanged
			details["insertions"] = agentCtx.GitInfo.Insertions
			details["deletions"] = agentCtx.GitInfo.Deletions
		}
	}

	// Attach the current task summary (pending todos, decisions, known
	// issues) so the IM completion notification carries a structured
	// snapshot of where the task left off, not just the final text.
	if summary, err := d.clawless.GetTaskSummary(ctx, task.ID); err == nil && summary != nil {
		if len(summary.Pending) > 0 {
			details["pending"] = summary.Pending
		}
		if len(summary.KnownIssues) > 0 {
			details["known_issues"] = summary.KnownIssues
		}
		if len(summary.Decisions) > 0 {
			details["decisions"] = summary.Decisions
		}
		if summary.Progress != "" {
			details["progress"] = summary.Progress
		}
	} else if err != nil {
		slog.Debug("completion: task summary fetch skipped", "task_id", task.ID, "error", err)
	}

	notification := map[string]any{
		"type":        "completion",
		"task_id":     task.ID,
		"status":      status,
		"title":       fmt.Sprintf("Task %s", status),
		"titleKey":    "agentd.notify.task",
		"titleValues": map[string]any{"status": status},
		"summary":     truncateStr(task.Result, 500),
		"details":     details,
	}

	// POST to ClawLess notification API
	clawlessURL := d.clawless.BaseURL
	if clawlessURL == "" {
		return
	}

	notifCtx, notifCancel := context.WithTimeout(ctx, 30*time.Second)
	defer notifCancel()

	body, _ := json.Marshal(notification)
	req, err := http.NewRequestWithContext(notifCtx, http.MethodPost,
		fmt.Sprintf("%s/api/agentd/v1/notifications/send", clawlessURL),
		bytes.NewReader(body))
	if err != nil {
		slog.Warn("failed to create notification request", "task_id", task.ID, "error", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if d.clawless.APIKey != "" {
		req.Header.Set("X-API-Key", d.clawless.APIKey)
	}

	resp, err := d.clawless.HTTPClient.Do(req)
	if err != nil {
		slog.Warn("notification send failed", "task_id", task.ID, "error", err)
		return
	}
	defer resp.Body.Close()

	slog.Info("completion notification sent", "task_id", task.ID, "status", resp.StatusCode)
}

func truncateStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func (d *Dispatcher) handleSandboxEvent(e eventbus.Event) {
	sb, ok := e.Payload.(*sandbox.Sandbox)
	if !ok {
		slog.Error("dispatch: invalid sandbox event payload", "type", e.Type)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	switch e.Type {
	case eventbus.EventSandboxCreated:
		meta := &clawless.SandboxMeta{
			ID:         sb.ID,
			Type:       sb.Type,
			Path:       sb.Path,
			Status:     "running",
			Persistent: sb.Persistent,
		}
		if err := d.clawless.RegisterSandbox(ctx, meta); err != nil {
			slog.Warn("failed to sync sandbox creation to ClawLess", "sandbox_id", sb.ID, "error", err)
		} else {
			slog.Info("sandbox synced to ClawLess", "sandbox_id", sb.ID, "type", sb.Type)
		}
	case eventbus.EventSandboxDestroyed:
		if err := d.clawless.UpdateSandboxStatus(ctx, sb.ID, "destroyed"); err != nil {
			slog.Warn("failed to sync sandbox destruction to ClawLess", "sandbox_id", sb.ID, "error", err)
		} else {
			slog.Info("sandbox destruction synced", "sandbox_id", sb.ID)
		}
	default:
		slog.Debug("unhandled sandbox event type", "type", e.Type)
	}
}

func (d *Dispatcher) handleSecurityAlert(e eventbus.Event) {
	payload, ok := e.Payload.(map[string]any)
	if !ok {
		slog.Error("dispatch: invalid security alert payload", "type", e.Type)
		return
	}

	level, _ := payload["level"].(string)
	reason, _ := payload["reason"].(string)
	taskID, _ := payload["task_id"].(string)
	sessionID, _ := payload["session_id"].(string)
	runID, _ := payload["run_id"].(string)
	if runID == "" {
		runID = d.l2Mgr.RunIDForTask(taskID)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Write review log for audit trail
	decision, _ := payload["decision"].(string)
	log := clawless.ReviewLog{
		TaskID:         taskID,
		SessionID:      sessionID,
		RunID:          runID,
		Command:        fmt.Sprintf("%v", payload["command"]),
		Level:          level,
		Score:          1.0,
		Decision:       decision,
		Reason:         reason,
		IdempotencyKey: fmt.Sprintf("review:%s:%s:%s:%s", taskID, level, decision, fmt.Sprintf("%v", payload["command"])),
	}
	if runID != "" {
		if err := d.clawless.WriteReviewLogs(ctx, []clawless.ReviewLog{log}); err != nil {
			slog.Warn("failed to write security alert review log", "task_id", taskID, "error", err)
		}
	} else {
		slog.Warn("security alert has no trace id; canonical review skipped", "task_id", taskID)
	}

	// Send urgent notification for high-frequency L0 blocks or consecutive L1 high scores
	title := "Security Alert"
	if level == "L0" {
		title = "L0 Rule Violation"
	} else if level == "L1" {
		title = "L1 High Risk Detected"
	}
	notification := &clawless.Notification{
		TaskID:   taskID,
		Type:     "security_alert",
		Title:    title,
		Message:  reason,
		Metadata: payload,
	}
	if err := d.clawless.CreateNotification(ctx, notification); err != nil {
		slog.Warn("failed to send security notification", "task_id", taskID, "error", err)
	} else {
		slog.Warn("security alert processed", "level", level, "task_id", taskID)
	}
}

func (d *Dispatcher) handleL2AuthRequired(e eventbus.Event) {
	payload, ok := e.Payload.(map[string]any)
	if !ok {
		slog.Error("dispatch: invalid L2 required payload", "type", e.Type)
		return
	}

	taskID, _ := payload["task_id"].(string)
	command, _ := payload["command"].(string)
	commandReview, _ := payload["command_review"].(string)
	if commandReview == "" {
		commandReview, _ = payload["commandReview"].(string)
	}
	reason, _ := payload["reason"].(string)
	level, _ := payload["level"].(string)
	score, _ := payload["score"].(float64)
	source, _ := payload["source"].(clawless.BotSource)
	if taskID == "" || command == "" {
		slog.Warn("L2 required event missing task_id or command", "task_id", taskID)
		return
	}
	if source.Type != "im" {
		slog.Info("L2 required without IM source; notification persisted only", "task_id", taskID)
		return
	}

	decisionID := taskID + ":" + generateProjectID()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	resp, err := d.clawless.SendNotification(ctx, map[string]any{
		"type":           "decision",
		"task_id":        taskID,
		"taskId":         taskID,
		"decisionId":     decisionID,
		"title":          "High-risk operation needs authorization",
		"titleKey":       "agentd.notify.l2Required",
		"body":           command,
		"command":        command,
		"commandReview":  commandReview,
		"command_review": commandReview,
		"score":          score,
		"reason":         reason,
		"level":          level,
		"source":         source,
		"options":        []string{"pass_once", "pass_until", "reject_once", "reject_until"},
		"expiresAt":      time.Now().Add(3 * time.Minute).Format(time.RFC3339),
		"message":        payload["message"],
		// node_id pins this pending decision to *this* daemon so the
		// user's verdict is routed back here (not to nodes[0]) in a
		// multi-node install. Empty when identity.Resolve never ran; the
		// Web side tolerates that and falls back to default resolution.
		"node_id": d.nodeID,
	})
	if err != nil {
		slog.Warn("L2 notification send failed", "task_id", taskID, "error", err)
		return
	}
	if resp == nil || resp.MessageID == "" {
		return
	}

	capabilities, err := d.clawless.GetCapabilities(ctx, source)
	if err != nil || capabilities == nil || !capabilities.Capabilities.Delete {
		return
	}

	go func() {
		time.Sleep(5 * time.Second)
		recallCtx, recallCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer recallCancel()
		if err := d.clawless.RecallNotification(recallCtx, source, resp.MessageID); err != nil {
			slog.Warn("L2 notification recall failed", "task_id", taskID, "message_id", resp.MessageID, "error", err)
		}
	}()
}

func (d *Dispatcher) handleL2Auth(e eventbus.Event) {
	payload, ok := e.Payload.(map[string]any)
	if !ok {
		slog.Error("dispatch: invalid L2 auth payload", "type", e.Type)
		return
	}

	taskID, _ := payload["task_id"].(string)
	command, _ := payload["command"].(string)
	action, _ := payload["action"].(string)
	duration, _ := payload["duration"].(string)
	runID, _ := payload["run_id"].(string)
	if runID == "" {
		runID = d.l2Mgr.RunIDForTask(taskID)
	}

	if taskID == "" || command == "" {
		slog.Warn("L2 auth event missing required fields", "task_id", taskID)
		return
	}

	slog.Info("L2 auth completed, updating cache and writing logs",
		"task_id", taskID, "command", command, "action", action, "duration", duration)

	// Update L2AuthCache
	if action == "pass" {
		if err := d.l2Mgr.AuthorizeTask(taskID, command, duration); err != nil {
			slog.Error("failed to update L2AuthCache", "task_id", taskID, "error", err)
		}
	} else if action == "reject" {
		if err := d.l2Mgr.RejectTask(taskID, command, duration); err != nil {
			slog.Error("failed to update L2AuthCache", "task_id", taskID, "error", err)
		}
	}

	// Write review log via ClawLess API
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	decision := "approved"
	if action == "reject" {
		decision = "rejected"
	}

	log := clawless.ReviewLog{
		TaskID:         taskID,
		RunID:          runID,
		Level:          "L2",
		Score:          0,
		Decision:       decision,
		Reason:         fmt.Sprintf("User %s: duration=%s", action, duration),
		Command:        command,
		IdempotencyKey: fmt.Sprintf("review:%s:L2:%s:%s", taskID, decision, command),
	}
	if runID == "" {
		slog.Warn("L2 auth has no trace id; canonical review skipped", "task_id", taskID)
	} else if err := d.clawless.WriteReviewLogs(ctx, []clawless.ReviewLog{log}); err != nil {
		slog.Error("failed to write L2 auth review log", "task_id", taskID, "error", err)
	} else {
		slog.Info("L2 auth review log written", "task_id", taskID, "decision", decision)
	}

	// Resume or cancel task - task data comes from clawless webhook payload
	if action == "pass" {
		taskData, hasTask := payload["task"].(map[string]any)
		if hasTask {
			task := &clawless.Task{
				ID:        taskID,
				AgentID:   getString(taskData, "agent_id"),
				SessionID: getString(taskData, "session_id"),
				Command:   getString(taskData, "command"),
			}
			d.bus.Publish(eventbus.EventTaskApproved, task)
		} else {
			slog.Warn("L2 auth approved but no task data in payload", "task_id", taskID)
		}
	} else if action == "reject" {
		taskData, hasTask := payload["task"].(map[string]any)
		if hasTask {
			task := &clawless.Task{
				ID:        taskID,
				AgentID:   getString(taskData, "agent_id"),
				SessionID: getString(taskData, "session_id"),
				Command:   getString(taskData, "command"),
			}
			d.bus.Publish(eventbus.EventTaskRejected, task)
		} else {
			slog.Warn("L2 auth rejected but no task data in payload", "task_id", taskID)
		}
	}
}

func getString(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func (d *Dispatcher) handleSessionClosed(e eventbus.Event) {
	payload, ok := e.Payload.(map[string]any)
	if !ok {
		slog.Error("dispatch: invalid session closed payload", "type", e.Type)
		return
	}

	sessionID, _ := payload["session_id"].(string)
	if sessionID == "" {
		slog.Warn("session closed event missing session_id")
		return
	}

	d.l2Mgr.ClearSession(sessionID)

	// Clean up session from store
	if err := d.agentManager.GetSessionStore().Delete(sessionID); err != nil {
		slog.Warn("failed to delete session from store", "session_id", sessionID, "error", err)
	}

	// Release sandbox if exclusive to this session (force-destroy so
	// LXC rootfs is torn down too — the session is gone for good).
	if ctx, ok := d.agentManager.GetSession(sessionID); ok && ctx.SandboxID != "" {
		if err := d.sbManager.DestroySandboxForce(ctx.SandboxID); err != nil {
			slog.Warn("failed to release sandbox on session close",
				"session_id", sessionID, "sandbox_id", ctx.SandboxID, "error", err)
		} else {
			slog.Info("sandbox released on session close", "session_id", sessionID, "sandbox_id", ctx.SandboxID)
		}
	}

	slog.Info("session closed cleanup complete", "session_id", sessionID)
}

func (d *Dispatcher) handleSessionArchived(e eventbus.Event) {
	payload, ok := e.Payload.(map[string]any)
	if !ok {
		slog.Error("dispatch: invalid session archived payload", "type", e.Type)
		return
	}

	sessionID, _ := payload["session_id"].(string)
	if sessionID == "" {
		slog.Warn("session archived event missing session_id")
		return
	}

	d.l2Mgr.ClearSession(sessionID)

	// Keep session JSON but mark as archived (handled by session store if needed)
	// Release sandbox resources (force-destroy so LXC rootfs is torn down).
	if ctx, ok := d.agentManager.GetSession(sessionID); ok && ctx.SandboxID != "" {
		if err := d.sbManager.DestroySandboxForce(ctx.SandboxID); err != nil {
			slog.Warn("failed to release sandbox on session archive",
				"session_id", sessionID, "sandbox_id", ctx.SandboxID, "error", err)
		} else {
			slog.Info("sandbox released on session archive", "session_id", sessionID, "sandbox_id", ctx.SandboxID)
		}
	}

	slog.Info("session archived cleanup complete", "session_id", sessionID)
}
