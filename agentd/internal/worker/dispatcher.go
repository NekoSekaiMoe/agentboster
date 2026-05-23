package worker

import (
	"context"
	"log/slog"
	"time"

	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/eventbus"
	"github.com/clawless/agentd/internal/sandbox"
	"github.com/clawless/agentd/internal/security"

)

// Dispatcher routes events from the bus to the appropriate worker pools.
type Dispatcher struct {
	bus         *eventbus.Bus
	taskPool    *Pool
	reviewPool  *Pool
	sandboxPool *Pool
	memoryPool  *Pool
	cleanupPool *Pool
	gatekeeper  *security.Gatekeeper
	sbManager   *sandbox.Manager
	clawless    *clawless.Client
}

// NewDispatcher creates a dispatcher with all worker pools and dependencies.
func NewDispatcher(
	bus *eventbus.Bus,
	numWorkers int,
	gk *security.Gatekeeper,
	sbManager *sandbox.Manager,
	clawlessClient *clawless.Client,
) *Dispatcher {
	d := &Dispatcher{
		bus:         bus,
		taskPool:    NewPool("task", numWorkers),
		reviewPool:  NewPool("review", numWorkers),
		sandboxPool: NewPool("sandbox", numWorkers),
		memoryPool:  NewPool("memory", 2),
		cleanupPool: NewPool("cleanup", 1),
		gatekeeper:  gk,
		sbManager:   sbManager,
		clawless:    clawlessClient,
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
	// Task created → Gatekeeper (L0→L1→L2)
	d.bus.Subscribe(eventbus.EventTaskCreated, func(e eventbus.Event) {
		d.reviewPool.Submit(func() {
			d.handleTaskCreated(e)
		})
	})

	// Task approved → sandbox execution
	d.bus.Subscribe(eventbus.EventTaskApproved, func(e eventbus.Event) {
		d.taskPool.Submit(func() {
			d.handleTaskApproved(e)
		})
	})

	// Task completed → memory extraction
	d.bus.Subscribe(eventbus.EventTaskCompleted, func(e eventbus.Event) {
		d.memoryPool.Submit(func() {
			d.handleTaskCompleted(e)
		})
	})

	// Sandbox lifecycle
	d.bus.Subscribe(eventbus.EventSandboxCreated, func(e eventbus.Event) {
		d.sandboxPool.Submit(func() {
			d.handleSandboxEvent(e)
		})
	})

	d.bus.Subscribe(eventbus.EventSandboxDestroyed, func(e eventbus.Event) {
		d.cleanupPool.Submit(func() {
			d.handleSandboxEvent(e)
		})
	})

	// Security alerts → review pool
	d.bus.Subscribe(eventbus.EventSecurityAlert, func(e eventbus.Event) {
		d.reviewPool.Submit(func() {
			d.handleSecurityAlert(e)
		})
	})

	// L2 auth events → review pool
	d.bus.Subscribe(eventbus.EventL2AuthRequired, func(e eventbus.Event) {
		d.reviewPool.Submit(func() {
			d.handleL2Auth(e)
		})
	})

	// L2 auth approved → re-approve task
	d.bus.Subscribe(eventbus.EventL2AuthApproved, func(e eventbus.Event) {
		d.reviewPool.Submit(func() {
			d.handleL2AuthApproved(e)
		})
	})

	// L2 auth rejected → reject task
	d.bus.Subscribe(eventbus.EventL2AuthRejected, func(e eventbus.Event) {
		d.bus.Publish(eventbus.EventTaskRejected, e.Payload)
	})
}

// handleTaskCreated runs the full Gatekeeper audit (L0→L1→L2).
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

	// Write review logs
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
		// Task is held — L2 auth handler will re-approve or reject
	}
}

// handleTaskApproved creates sandbox and executes the command.
func (d *Dispatcher) handleTaskApproved(e eventbus.Event) {
	task, ok := e.Payload.(*clawless.Task)
	if !ok {
		slog.Error("dispatch: invalid task payload", "type", e.Type)
		return
	}

	slog.Info("dispatch: task approved, executing in sandbox", "task_id", task.ID)

	sbType := sandbox.SelectSandbox(task, nil)

	sbSpec := sandbox.SandboxSpec{
		Type:    sbType,
		AgentID: task.AgentID,
	}
	sb, err := d.sbManager.CreateSandbox(sbSpec)
	if err != nil {
		slog.Error("sandbox creation failed", "task_id", task.ID, "error", err)
		d.bus.Publish(eventbus.EventTaskFailed, task)
		return
	}

	d.bus.Publish(eventbus.EventSandboxCreated, sb)

	result, err := d.sbManager.Exec(sb.ID, task.Command, task.Env, task.Timeout)
	if err != nil {
		slog.Error("sandbox exec failed", "task_id", task.ID, "sandbox_id", sb.ID, "error", err)
		d.bus.Publish(eventbus.EventTaskFailed, task)
		return
	}

	slog.Info("task executed",
		"task_id", task.ID,
		"sandbox_id", sb.ID,
		"exit_code", result.ExitCode,
		"duration", result.Duration,
	)

	task.Result = result.Stdout
	if result.ExitCode != 0 {
		task.Result += "\n[stderr]\n" + result.Stderr
	}

	if !sb.Persistent {
		if err := d.sbManager.DestroySandbox(sb.ID); err != nil {
			slog.Warn("sandbox destroy failed", "sandbox_id", sb.ID, "error", err)
		}
		d.bus.Publish(eventbus.EventSandboxDestroyed, sb)
	}

	if result.ExitCode == 0 {
		d.bus.Publish(eventbus.EventTaskCompleted, task)
	} else {
		d.bus.Publish(eventbus.EventTaskFailed, task)
	}
}

// handleL2AuthApproved re-approves a task after L2 authorization.
func (d *Dispatcher) handleL2AuthApproved(e eventbus.Event) {
	task, ok := e.Payload.(*clawless.Task)
	if !ok {
		slog.Error("dispatch: invalid task payload for L2 auth approved")
		return
	}
	slog.Info("L2 auth approved, re-approving task", "task_id", task.ID)
	d.bus.Publish(eventbus.EventTaskApproved, task)
}

func (d *Dispatcher) handleTaskCompleted(e eventbus.Event) {
	slog.Info("dispatch: task completed, extracting memory", "type", e.Type)
	// Phase 5: memory extraction
}

func (d *Dispatcher) handleSandboxEvent(e eventbus.Event) {
	slog.Info("dispatch: sandbox event", "type", e.Type)
}

func (d *Dispatcher) handleSecurityAlert(e eventbus.Event) {
	slog.Warn("dispatch: security alert", "type", e.Type)
}

func (d *Dispatcher) handleL2Auth(e eventbus.Event) {
	slog.Info("dispatch: L2 auth required", "type", e.Type)
	// The L2 auth notification is already sent by the Gatekeeper.
	// This handler can be used for escalation if L2 times out.
}


