package worker

import (
	"log/slog"

	"github.com/clawless/agentd/internal/eventbus"
)

// Dispatcher routes events from the bus to the appropriate worker pools.
type Dispatcher struct {
	bus         *eventbus.Bus
	taskPool    *Pool
	reviewPool  *Pool
	sandboxPool *Pool
	memoryPool  *Pool
	cleanupPool *Pool
}

// NewDispatcher creates a dispatcher with all worker pools.
func NewDispatcher(bus *eventbus.Bus, numWorkers int) *Dispatcher {
	d := &Dispatcher{
		bus:         bus,
		taskPool:    NewPool("task", numWorkers),
		reviewPool:  NewPool("review", numWorkers),
		sandboxPool: NewPool("sandbox", numWorkers),
		memoryPool:  NewPool("memory", 2),
		cleanupPool: NewPool("cleanup", 1),
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
	// Task created → review
	d.bus.Subscribe(eventbus.EventTaskCreated, func(e eventbus.Event) {
		d.reviewPool.Submit(func() {
			d.handleTaskCreated(e)
		})
	})

	// Task approved → execute
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

// Handler stubs — implemented in later phases.

func (d *Dispatcher) handleTaskCreated(e eventbus.Event) {
	slog.Info("dispatch: task created, routing to review", "type", e.Type)
	// Phase 3: L0/L1/L2 review
}

func (d *Dispatcher) handleTaskApproved(e eventbus.Event) {
	slog.Info("dispatch: task approved, routing to execution", "type", e.Type)
	// Phase 2: sandbox execution
}

func (d *Dispatcher) handleTaskCompleted(e eventbus.Event) {
	slog.Info("dispatch: task completed, extracting memory", "type", e.Type)
	// Phase 5: memory extraction
}

func (d *Dispatcher) handleSandboxEvent(e eventbus.Event) {
	slog.Info("dispatch: sandbox event", "type", e.Type)
	// Phase 2: sandbox management
}

func (d *Dispatcher) handleSecurityAlert(e eventbus.Event) {
	slog.Warn("dispatch: security alert", "type", e.Type)
	// Phase 3: security handling
}

func (d *Dispatcher) handleL2Auth(e eventbus.Event) {
	slog.Info("dispatch: L2 auth required", "type", e.Type)
	// Phase 3: L2 authorization
}
