package worker

import (
	"log/slog"

	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/eventbus"
	"github.com/clawless/agentd/internal/sandbox"
	"github.com/clawless/agentd/internal/security/l0_rules"
)

// Dispatcher routes events from the bus to the appropriate worker pools.
type Dispatcher struct {
	bus         *eventbus.Bus
	taskPool    *Pool
	reviewPool  *Pool
	sandboxPool *Pool
	memoryPool  *Pool
	cleanupPool *Pool
	l0Engine   *l0_rules.Engine
	sbManager  *sandbox.Manager
	clawless   *clawless.Client
}

// NewDispatcher creates a dispatcher with all worker pools and dependencies.
func NewDispatcher(
	bus *eventbus.Bus,
	numWorkers int,
	l0Engine *l0_rules.Engine,
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
		l0Engine:   l0Engine,
		sbManager:  sbManager,
		clawless:   clawlessClient,
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
	// Task created → L0 review
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
}

// handleTaskCreated runs L0 check, then approves or rejects.
func (d *Dispatcher) handleTaskCreated(e eventbus.Event) {
	task, ok := e.Payload.(*clawless.Task)
	if !ok {
		slog.Error("dispatch: invalid task payload", "type", e.Type)
		return
	}

	slog.Info("dispatch: task created, running L0 review", "task_id", task.ID)

	// L0 security check
	result, err := d.l0Engine.Check(task.Command, "")
	if err != nil {
		slog.Error("L0 check error", "task_id", task.ID, "error", err)
		d.bus.Publish(eventbus.EventTaskFailed, task)
		return
	}

	if result != nil && result.Blocked {
		slog.Warn("L0 blocked task",
			"task_id", task.ID,
			"rule_id", result.Rule.ID,
			"reason", result.Reason,
		)
		d.bus.Publish(eventbus.EventSecurityAlert, map[string]any{
			"task_id":  task.ID,
			"level":    "L0",
			"decision": "blocked",
			"reason":   result.Reason,
			"command":  task.Command,
		})
		d.bus.Publish(eventbus.EventTaskRejected, task)
		return
	}

	if result != nil {
		slog.Info("L0 warn, proceeding", "task_id", task.ID, "rule_id", result.Rule.ID)
	}

	// L0 passed → approve
	slog.Info("L0 check passed", "task_id", task.ID)
	d.bus.Publish(eventbus.EventTaskApproved, task)
}

// handleTaskApproved creates sandbox and executes the command.
func (d *Dispatcher) handleTaskApproved(e eventbus.Event) {
	task, ok := e.Payload.(*clawless.Task)
	if !ok {
		slog.Error("dispatch: invalid task payload", "type", e.Type)
		return
	}

	slog.Info("dispatch: task approved, executing in sandbox", "task_id", task.ID)

	// Auto-select sandbox type
	sbType := sandbox.SelectSandbox(task, nil)

	// Create sandbox
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

	// Publish sandbox created event
	d.bus.Publish(eventbus.EventSandboxCreated, sb)

	// Execute command
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

	// Store result
	task.Result = result.Stdout
	if result.ExitCode != 0 {
		task.Result += "\n[stderr]\n" + result.Stderr
	}

	// Destroy non-persistent sandbox
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

func (d *Dispatcher) handleTaskCompleted(e eventbus.Event) {
	slog.Info("dispatch: task completed, extracting memory", "type", e.Type)
	// Phase 5: memory extraction
}

func (d *Dispatcher) handleSandboxEvent(e eventbus.Event) {
	slog.Info("dispatch: sandbox event", "type", e.Type)
}

func (d *Dispatcher) handleSecurityAlert(e eventbus.Event) {
	slog.Warn("dispatch: security alert", "type", e.Type)
	// Phase 3: L1/L2 handling
}

func (d *Dispatcher) handleL2Auth(e eventbus.Event) {
	slog.Info("dispatch: L2 auth required", "type", e.Type)
	// Phase 3: L2 authorization
}
