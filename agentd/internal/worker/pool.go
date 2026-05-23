package worker

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
)

// Pool manages a dynamic set of goroutine workers (replicating Asika Worker Pool pattern).
type Pool struct {
	name       string
	numWorkers int
	ch         chan func()
	wg         sync.WaitGroup
	running    atomic.Bool
	ctx        context.Context
	cancel     context.CancelFunc
}

// NewPool creates a worker pool with the given size.
func NewPool(name string, size int) *Pool {
	ctx, cancel := context.WithCancel(context.Background())
	return &Pool{
		name:       name,
		numWorkers: size,
		ch:         make(chan func(), size*2),
		ctx:        ctx,
		cancel:     cancel,
	}
}

// Start launches the worker goroutines.
func (p *Pool) Start() {
	if p.running.Load() {
		return
	}
	p.running.Store(true)
	for i := 0; i < p.numWorkers; i++ {
		p.wg.Add(1)
		go p.worker(i)
	}
	slog.Info("worker pool started", "name", p.name, "workers", p.numWorkers)
}

// Stop gracefully shuts down the pool.
func (p *Pool) Stop() {
	if !p.running.Load() {
		return
	}
	p.running.Store(false)
	p.cancel()
	close(p.ch)
	p.wg.Wait()
	slog.Info("worker pool stopped", "name", p.name)
}

// Submit sends a job to the pool. Returns false if pool is stopped.
func (p *Pool) Submit(job func()) bool {
	if !p.running.Load() {
		return false
	}
	select {
	case p.ch <- job:
		return true
	case <-p.ctx.Done():
		return false
	}
}

func (p *Pool) worker(id int) {
	defer p.wg.Done()
	for job := range p.ch {
		func() {
			defer func() {
				if r := recover(); r != nil {
					slog.Error("worker panic", "pool", p.name, "worker", id, "error", r)
				}
			}()
			job()
		}()
	}
}
