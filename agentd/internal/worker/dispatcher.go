package worker

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/clawless/agentd/internal/agent"
	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/eventbus"
	"github.com/clawless/agentd/internal/sandbox"
	"github.com/clawless/agentd/internal/security"
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
}

// NewDispatcher creates a dispatcher with all worker pools and dependencies.
func NewDispatcher(
	bus *eventbus.Bus,
	numWorkers int,
	gk *security.Gatekeeper,
	sbManager *sandbox.Manager,
	clawlessClient *clawless.Client,
	agentManager *agent.Manager,
) *Dispatcher {
	d := &Dispatcher{
		bus:          bus,
		taskPool:     NewPool("task", numWorkers),
		reviewPool:   NewPool("review", numWorkers),
		sandboxPool:  NewPool("sandbox", numWorkers),
		memoryPool:   NewPool("memory", 2),
		cleanupPool:  NewPool("cleanup", 1),
		gatekeeper:   gk,
		sbManager:    sbManager,
		clawless:     clawlessClient,
		agentManager: agentManager,
	}
	d.registerRoutes()
	return d
}

// Start launches all worker pools.
func (d *Dispatcher) Start() {
	d.taskPool.Start()
	d.reviewPool.Start()
	d.sandboxPool.Start()
	d.memoryPool.Start()
	d.cleanupPool.Start()
}

// Stop gracefully shuts down all pools.
func (d *Dispatcher) Stop() {
	d.taskPool.Stop()
	d.reviewPool.Stop()
	d.sandboxPool.Stop()
	d.memoryPool.Stop()
	d.cleanupPool.Stop()
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

	slog.Info("dispatch: task completed, extracting memory", "task_id", task.ID)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if err := d.agentManager.ExtractMemory(ctx, task); err != nil {
		slog.Warn("memory extraction failed", "task_id", task.ID, "error", err)
	}
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

func (d *Dispatcher) handleSandboxEvent(e eventbus.Event) {
	slog.Info("dispatch: sandbox event", "type", e.Type)
}

func (d *Dispatcher) handleSecurityAlert(e eventbus.Event) {
	slog.Warn("dispatch: security alert", "type", e.Type)
}

func (d *Dispatcher) handleL2Auth(e eventbus.Event) {
	slog.Info("dispatch: L2 auth required", "type", e.Type)
}
