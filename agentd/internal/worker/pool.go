package worker

import (
	"context"
	"log/slog"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/clawless/agentd/internal/config"
)

type poolMetrics struct {
	workers         atomic.Int32
	totalTasks      atomic.Uint64
	activeTasks     atomic.Int32
	utilization     atomic.Int32
	scaleUpEvents   atomic.Uint64
	scaleDownEvents atomic.Uint64
}

func (m *poolMetrics) snapshot() map[string]any {
	return map[string]any{
		"workers":         m.workers.Load(),
		"total_tasks":     m.totalTasks.Load(),
		"active_tasks":    m.activeTasks.Load(),
		"utilization_pct": m.utilization.Load(),
		"scale_ups":       m.scaleUpEvents.Load(),
		"scale_downs":     m.scaleDownEvents.Load(),
		"goroutines":      runtime.NumGoroutine(),
	}
}

// Pool manages a dynamic set of goroutine workers (from Asika).
type Pool struct {
	name  string
	tasks chan func()
	stop  chan struct{}
	wg    sync.WaitGroup
	metrics *poolMetrics
	cfg   atomic.Value

	minWorkers   int
	maxWorkers   int
	scaleUpPct   int
	scaleDownPct int
	cooldown     time.Duration
	nextID       atomic.Int32

	mu         sync.Mutex
	cancels    []context.CancelFunc
	lastScaled time.Time
	stopped    atomic.Bool
}

// NewPool creates a dynamic worker pool.
func NewPool(name string, cfg config.WorkerPoolConfig) *Pool {
	maxW := cfg.MaxWorkers
	if maxW <= 0 {
		maxW = runtime.NumCPU() * 4
	}
	p := &Pool{
		name:         name,
		tasks:        make(chan func(), maxW*4),
		stop:         make(chan struct{}),
		metrics:      &poolMetrics{},
		minWorkers:   cfg.MinWorkers,
		maxWorkers:   maxW,
		scaleUpPct:   cfg.ScaleUpPct,
		scaleDownPct: cfg.ScaleDownPct,
		cooldown:     time.Duration(cfg.CooldownSecs) * time.Second,
	}
	p.cfg.Store(cfg)

	for i := 0; i < cfg.MinWorkers; i++ {
		p.spawnWorker()
	}

	p.wg.Add(1)
	go p.adjustLoop()

	slog.Info("worker pool started", "name", name, "min", cfg.MinWorkers, "max", maxW, "buffer", maxW*4)
	return p
}

func (p *Pool) spawnWorker() {
	if p.stopped.Load() {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	id := p.nextID.Add(1)
	p.metrics.workers.Add(1)

	p.mu.Lock()
	p.cancels = append(p.cancels, cancel)
	p.mu.Unlock()

	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		defer p.metrics.workers.Add(-1)
		for {
			select {
			case <-ctx.Done():
				return
			case <-p.stop:
				// Drain remaining tasks before exiting
				for {
					select {
					case task, ok := <-p.tasks:
						if !ok {
							return
						}
						p.exec(task)
					default:
						return
					}
				}
			case task, ok := <-p.tasks:
				if !ok {
					return
				}
				p.exec(task)
			}
		}
	}()
	slog.Debug("worker spawned", "pool", p.name, "id", id, "total", p.metrics.workers.Load())
}

func (p *Pool) exec(task func()) {
	p.metrics.activeTasks.Add(1)
	p.metrics.totalTasks.Add(1)
	defer func() {
		if r := recover(); r != nil {
			slog.Error("worker panic", "pool", p.name, "error", r)
		}
		p.metrics.activeTasks.Add(-1)
	}()
	task()
}

// Submit sends a job to the pool.
func (p *Pool) Submit(task func()) {
	select {
	case p.tasks <- task:
	case <-p.stop:
		slog.Warn("worker pool: submit after stop, dropping task", "pool", p.name)
	}
}

// Stop gracefully shuts down the pool.
func (p *Pool) Stop() {
	p.stopped.Store(true)
	close(p.stop)
	p.wg.Wait()
	slog.Info("worker pool stopped", "name", p.name)
}

// Metrics returns a snapshot of pool metrics.
func (p *Pool) Metrics() map[string]any {
	return p.metrics.snapshot()
}

// UpdateConfig updates the pool configuration at runtime.
func (p *Pool) UpdateConfig(cfg config.WorkerPoolConfig) {
	maxW := cfg.MaxWorkers
	if maxW <= 0 {
		maxW = runtime.NumCPU() * 4
	}
	p.mu.Lock()
	p.minWorkers = cfg.MinWorkers
	p.maxWorkers = maxW
	p.scaleUpPct = cfg.ScaleUpPct
	p.scaleDownPct = cfg.ScaleDownPct
	p.cooldown = time.Duration(cfg.CooldownSecs) * time.Second
	p.mu.Unlock()
	p.cfg.Store(cfg)
	slog.Info("worker pool config updated", "name", p.name, "min", cfg.MinWorkers, "max", maxW)
}

func (p *Pool) adjustLoop() {
	defer p.wg.Done()
	d := 30 * time.Second
	if cfg, ok := p.cfg.Load().(config.WorkerPoolConfig); ok {
		if parsed, err := time.ParseDuration(cfg.StatsInterval); err == nil && parsed > 0 {
			d = parsed
		}
	}
	ticker := time.NewTicker(d)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			p.adjust()
		case <-p.stop:
			return
		}
	}
}

func (p *Pool) adjust() {
	if p.stopped.Load() {
		return
	}
	capVal := cap(p.tasks)
	if capVal == 0 {
		return
	}
	used := len(p.tasks)
	pct := (used * 100) / capVal
	p.metrics.utilization.Store(int32(pct))

	now := time.Now()
	currentWorkers := int(p.metrics.workers.Load())

	p.mu.Lock()
	canScale := now.Sub(p.lastScaled) >= p.cooldown
	scaleUp := p.scaleUpPct
	scaleDown := p.scaleDownPct
	maxW := p.maxWorkers
	minW := p.minWorkers
	p.mu.Unlock()

	if !canScale {
		return
	}

	if pct >= scaleUp && currentWorkers < maxW {
		p.mu.Lock()
		p.lastScaled = now
		p.mu.Unlock()
		p.spawnWorker()
		p.metrics.scaleUpEvents.Add(1)
		slog.Info("pool scale up", "pool", p.name, "workers", currentWorkers+1, "utilization_pct", pct)
		return
	}

	if pct <= scaleDown && currentWorkers > minW {
		p.mu.Lock()
		p.lastScaled = now
		if len(p.cancels) > 0 {
			p.cancels[len(p.cancels)-1]()
			p.cancels = p.cancels[:len(p.cancels)-1]
		}
		p.mu.Unlock()
		p.metrics.scaleDownEvents.Add(1)
		slog.Info("pool scale down", "pool", p.name, "workers", currentWorkers-1, "utilization_pct", pct)
	}
}
