package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/clawless/agentd/internal/agent"
	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/eventbus"
	"github.com/clawless/agentd/internal/sandbox"
	"github.com/clawless/agentd/internal/security"
	"github.com/clawless/agentd/internal/worker/workers"
)

// Dispatcher routes events from the bus to the appropriate worker pools.
type Dispatcher struct {
	bus          *eventbus.Bus
	taskPool     *Pool
	reviewPool   *Pool
	sandboxPool  *Pool
	memoryPool   *Pool
	cleanupPool  *Pool
	gatekeeper   *security.Gatekeeper
	sbManager    *sandbox.Manager
	clawless     *clawless.Client
	agentManager *agent.Manager
	tidyInterval time.Duration
	tidyStop     chan struct{}
}

// PoolSizes holds the worker pool size configuration.
type PoolSizes struct {
	Review  int
	Sandbox int
	Task    int
	Memory  int
	Cleanup int
}

// NewDispatcher creates a dispatcher with all worker pools and dependencies.
func NewDispatcher(
	bus *eventbus.Bus,
	sizes PoolSizes,
	gk *security.Gatekeeper,
	sbManager *sandbox.Manager,
	clawlessClient *clawless.Client,
	agentManager *agent.Manager,
	tidyInterval time.Duration,
) *Dispatcher {
	d := &Dispatcher{
		bus:          bus,
		taskPool:     NewPool("task", sizes.Task),
		reviewPool:   NewPool("review", sizes.Review),
		sandboxPool:  NewPool("sandbox", sizes.Sandbox),
		memoryPool:   NewPool("memory", sizes.Memory),
		cleanupPool:  NewPool("cleanup", sizes.Cleanup),
		gatekeeper:   gk,
		sbManager:    sbManager,
		clawless:     clawlessClient,
		agentManager: agentManager,
		tidyInterval: tidyInterval,
		tidyStop:     make(chan struct{}),
	}
	d.registerRoutes()
	return d
}

// Start launches all worker pools and the tidy ticker.
func (d *Dispatcher) Start() {
	d.taskPool.Start()
	d.reviewPool.Start()
	d.sandboxPool.Start()
	d.memoryPool.Start()
	d.cleanupPool.Start()
	d.startTidyTicker()
}

// Stop gracefully shuts down all pools and the tidy ticker.
func (d *Dispatcher) Stop() {
	close(d.tidyStop)
	d.taskPool.Stop()
	d.reviewPool.Stop()
	d.sandboxPool.Stop()
	d.memoryPool.Stop()
	d.cleanupPool.Stop()
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
	d.bus.Subscribe(eventbus.EventL2AuthRequired, func(e eventbus.Event) {
		d.reviewPool.Submit(func() { d.handleL2Auth(e) })
	})
	d.bus.Subscribe(eventbus.EventL2AuthApproved, func(e eventbus.Event) {
		d.reviewPool.Submit(func() { d.handleL2AuthApproved(e) })
	})
	d.bus.Subscribe(eventbus.EventL2AuthRejected, func(e eventbus.Event) {
		d.bus.Publish(eventbus.EventTaskRejected, e.Payload)
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

	if len(logs) > 0 {
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

	// Set sandbox info
	agentCtx.SandboxID = task.SandboxID
	if agentCtx.SandboxID == "" {
		// Create a sandbox for the agent
		sbSpec := sandbox.SandboxSpec{
			Type:    sandbox.SelectSandbox(task, nil),
			AgentID: task.AgentID,
		}
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

func (d *Dispatcher) handleTaskCompleted(e eventbus.Event) {
	task, ok := e.Payload.(*clawless.Task)
	if !ok {
		slog.Error("dispatch: invalid task payload", "type", e.Type)
		return
	}

	slog.Info("dispatch: task completed", "task_id", task.ID)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Check if this is a long-running task (has a task summary)
	summary, err := d.clawless.GetTaskSummary(ctx, task.ID)
	if err != nil {
		slog.Info("dispatch: no task summary found, treating as short task", "task_id", task.ID)
	}

	if summary != nil {
		// Long-running task: update the summary with final progress
		slog.Info("dispatch: long-running task detected, updating summary", "task_id", task.ID)
		_, _ = d.clawless.UpdateTaskSummary(ctx, task.ID, clawless.TaskSummaryUpdate{
			Progress: strPtr(fmt.Sprintf("Completed: %s", truncateStr(task.Result, 200))),
		})
	} else {
		// Short task: extract memory as before
		slog.Info("dispatch: extracting memory for short task", "task_id", task.ID)
		if err := d.agentManager.ExtractMemory(ctx, task); err != nil {
			slog.Warn("memory extraction failed", "task_id", task.ID, "error", err)
		}
	}

	// Send completion notification via ClawLess API
	d.sendCompletionNotification(ctx, task)
}

func (d *Dispatcher) handleTaskTidyTick(e eventbus.Event) {
	slog.Info("dispatch: task tidy tick")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	summaries, err := d.clawless.ListActiveTaskSummaries(ctx, "default")
	if err != nil {
		slog.Warn("task tidy: failed to list active summaries", "error", err)
		return
	}

	if len(summaries) == 0 {
		slog.Info("task tidy: no active summaries to scan")
		return
	}

	taskIDs := make([]string, len(summaries))
	for i, s := range summaries {
		taskIDs[i] = s.TaskID
	}

	if err := workers.RunTaskTidy(ctx, d.clawless, d.agentManager, taskIDs); err != nil {
		slog.Warn("task tidy failed", "error", err)
	}
}

func strPtr(s string) *string {
	return &s
}

func (d *Dispatcher) sendCompletionNotification(ctx context.Context, task *clawless.Task) {
	// Determine status from task
	status := "completed"
	if task.Status == "failed" {
		status = "failed"
	} else if task.Status == "cancelled" {
		status = "cancelled"
	}

	notification := map[string]any{
		"type":    "completion",
		"task_id": task.ID,
		"status":  status,
	"title":   fmt.Sprintf("Task %s", status),
		"summary": truncateStr(task.Result, 500),
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

	resp, err := d.clawless.HTTPClient.Do(req)
	if err != nil {
		slog.Warn("notification send failed", "task_id", task.ID, "error", err)
		return
	}
	defer resp.Body.Close()

	slog.Info("completion notification sent", "task_id", task.ID, "status", resp.StatusCode)
}

func (d *Dispatcher) handleL2AuthApproved(e eventbus.Event) {
	task, ok := e.Payload.(*clawless.Task)
	if !ok {
		slog.Error("dispatch: invalid task payload for L2 auth approved")
		return
	}
	slog.Info("L2 auth approved, re-approving task", "task_id", task.ID)
	d.bus.Publish(eventbus.EventTaskApproved, task)
}

func truncateStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func (d *Dispatcher) handleSandboxEvent(e eventbus.Event) {
	slog.Info("dispatch: sandbox event", "type", e.Type)
}

func (d *Dispatcher) handleSecurityAlert(e eventbus.Event) {
	slog.Warn("dispatch: security alert", "type", e.Type)
}

func (d *Dispatcher) handleL2Auth(e eventbus.Event) {
	slog.Info("dispatch: L2 auth required", "type", e.Type)
}

func (d *Dispatcher) handleSessionClosed(e eventbus.Event) {
	slog.Info("dispatch: session closed", "type", e.Type)
}

func (d *Dispatcher) handleSessionArchived(e eventbus.Event) {
	slog.Info("dispatch: session archived", "type", e.Type)
}
