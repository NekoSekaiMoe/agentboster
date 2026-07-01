package agent

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
)

// TestSubagentSemaphore_ConcurrencyLimit verifies the global semaphore
// caps concurrent sub-agent goroutines at the configured limit.
//
// The semaphore is package-level (var subagentSem), so this test is
// order-sensitive within the package but isolated from other packages.
// Default cap is DefaultMaxParallelSubAgents = 3.
func TestSubagentSemaphore_ConcurrencyLimit(t *testing.T) {
	// Reset to default cap (other tests may have shrunk it).
	SetMaxParallelSubagents(3)

	const numGoroutines = 10
	var concurrent int32
	var maxConcurrent int32
	done := make(chan struct{}, numGoroutines)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	for i := 0; i < numGoroutines; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			if err := acquireSubagentSlot(ctx); err != nil {
				t.Errorf("acquire failed: %v", err)
				return
			}
			defer releaseSubagentSlot()

			cur := atomic.AddInt32(&concurrent, 1)
			for {
				old := atomic.LoadInt32(&maxConcurrent)
				if cur <= old || atomic.CompareAndSwapInt32(&maxConcurrent, old, cur) {
					break
				}
			}
			time.Sleep(50 * time.Millisecond)
			atomic.AddInt32(&concurrent, -1)
		}()
	}

	for i := 0; i < numGoroutines; i++ {
		select {
		case <-done:
		case <-ctx.Done():
			t.Fatalf("test timed out: %v", ctx.Err())
		}
	}

	if max := atomic.LoadInt32(&maxConcurrent); max > 3 {
		t.Errorf("max concurrent = %d; want <= 3 (DefaultMaxParallelSubAgents)", max)
	}
}

// TestSubagentSemaphore_Resize verifies SetMaxParallelSubAgents changes
// the effective cap. This validates the P1.1 forward-compat hook that
// will be called from agent config (MaxParallelSubAgents field).
func TestSubagentSemaphore_Resize(t *testing.T) {
	SetMaxParallelSubagents(1)

	var concurrent int32
	done := make(chan struct{}, 4)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	for i := 0; i < 4; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			if err := acquireSubagentSlot(ctx); err != nil {
				return
			}
			defer releaseSubagentSlot()
			cur := atomic.AddInt32(&concurrent, 1)
			if cur > 1 {
				t.Errorf("cap=1 but saw %d concurrent", cur)
			}
			time.Sleep(20 * time.Millisecond)
			atomic.AddInt32(&concurrent, -1)
		}()
	}

	for i := 0; i < 4; i++ {
		select {
		case <-done:
		case <-ctx.Done():
			t.Fatalf("timed out: %v", ctx.Err())
		}
	}

	// Reset for any subsequent tests.
	SetMaxParallelSubagents(3)
}

// TestSubagentSemaphore_CtxCancel verifies that acquire honours context
// cancellation — a stuck caller shouldn't block forever.
func TestSubagentSemaphore_CtxCancel(t *testing.T) {
	SetMaxParallelSubagents(1)

	// Hold the single slot.
	if err := acquireSubagentSlot(context.Background()); err != nil {
		t.Fatalf("setup acquire: %v", err)
	}
	defer releaseSubagentSlot()

	// Try to acquire with a short-timeout context.
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	err := acquireSubagentSlot(ctx)
	if err == nil {
		releaseSubagentSlot()
		t.Fatalf("acquire should have failed on cancelled ctx")
	}

	SetMaxParallelSubagents(3)
}

// TestSubagentRegistry_StoreAndRetrieve verifies StoreSubagentResult
// makes the result retrievable through the (package-global) registry.
// This is the function P0.1 wired into the subagent_runner.
func TestSubagentRegistry_StoreAndRetrieve(t *testing.T) {
	// Reset state.
	subagentRegistry.mu.Lock()
	subagentRegistry.agents = make(map[string]*clawless.Task)
	subagentRegistry.results = make(map[string]string)
	subagentRegistry.summaries = make(map[string]string)
	subagentRegistry.mu.Unlock()

	id := "test-subagent-1"
	subagentRegistry.mu.Lock()
	subagentRegistry.agents[id] = &clawless.Task{ID: id}
	subagentRegistry.mu.Unlock()

	StoreSubagentResult(id, "raw output here", "summary here")

	subagentRegistry.mu.RLock()
	raw, hasRaw := subagentRegistry.results[id]
	summary, hasSummary := subagentRegistry.summaries[id]
	subagentRegistry.mu.RUnlock()

	if !hasRaw || raw != "raw output here" {
		t.Errorf("results[%q] = %q (ok=%v); want stored raw", id, raw, hasRaw)
	}
	if !hasSummary || summary != "summary here" {
		t.Errorf("summaries[%q] = %q (ok=%v); want stored summary", id, summary, hasSummary)
	}
}
