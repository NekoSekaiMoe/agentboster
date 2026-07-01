package workers

import (
	"container/list"
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/eventbus"
)

// ExecResult is the per-command result payload carried by EventExecCompleted.
//
// matches Step 5's ExecResult — adjust fields if Step 5 differs.
//
// This is the worker-pool-payload form, distinct from sandbox.ExecResult (the
// sandbox-provider's return value: Stdout / Stderr / ExitCode / Duration).
// exec_worker (Step 7) is expected to build this struct from sandbox.ExecResult
// and publish it on the bus.
//
// BatchID is a small extension to plan §4's ExecResult shape — the collector
// needs it to correlate each completion with the right batchState. If Step 5 /
// Step 7 lands a different correlation key (e.g. a wrapper envelope), update
// this struct in lock-step.
type ExecResult struct {
	BatchID     string // identifies which batch this completion belongs to
	ID          string // exec command ID (ULID); key in batchState.results
	Index       int
	Status      string // "ok" | "error" — drives fail-fast short-circuit
	ExitCode    int
	Stdout      string
	Stderr      string
	Duration    time.Duration
	Error       string // populated on infra errors (sandbox create failed, etc.)
	SandboxID   string
	SandboxType string
	Truncated   bool // true when stdout/stderr hit the 100 KiB cap
}

// BatchCompletionPayload is the body of EventExecBatchCompleted /
// EventExecBatchFailed. Exactly one of these is published per batch, with all
// collected per-command results attached so the tool handler (Step 9) can
// return them to the LLM in input order.
type BatchCompletionPayload struct {
	BatchID string
	Results map[string]*ExecResult
	Failed  bool
	Reason  string // populated on failure (fail-fast, abort, external batch_failed)
}

// batchState is the per-batch in-flight state. The collector keeps one of
// these per outstanding batch; it is only removed from the LRU on natural
// eviction (size pressure). Settled batches stay in the map so late events
// can be dropped with a clear "batch_settled" log instead of a "late_event"
// log.
type batchState struct {
	batchID  string
	expected int
	received int
	failFast bool
	results  map[string]*ExecResult
	failed   bool
	reason   string
	abortCh  chan struct{}
	doneOnce sync.Once
}

// settled reports whether the batch has already fired its final event.
func (s *batchState) settled() bool {
	select {
	case <-s.abortCh:
		return true
	default:
		return false
	}
}

// BatchCollector aggregates per-command EventExecCompleted events into a
// single per-batch EventExecBatchCompleted (or EventExecBatchFailed under
// fail-fast / abort). It is the inverse of the exec pool fan-out: N
// completion events collapse back to ONE completion event (or one failure
// event).
//
// Concurrency model:
//   - One collector instance per process, owned by the dispatcher (Step 6).
//   - Submit registers a new batch; the returned channel closes when the
//     batch settles (all N completions arrive, fail-fast triggers, or Abort
//     fires).
//   - Event handlers run on the bus's dedicated goroutine — they return
//     quickly and never block on the abortCh or on a sync.WaitGroup.
//   - LRU eviction bounds memory at lruSize entries (default 1024).
type BatchCollector struct {
	bus     *eventbus.Bus
	mu      sync.Mutex
	lru     *list.List               // front = oldest, back = newest; element.Value = *batchState
	batches map[string]*list.Element // batchID -> *list.Element(*batchState)
	lruSize int

	cancels []func() // bus subscriptions; torn down on ctx.Done
}

// NewBatchCollector creates a collector that publishes batch-completion
// events back to bus. lruSize is the hard cap on outstanding batches; pass
// 0 (or negative) for the default (1024 — see decisions.md #9).
func NewBatchCollector(bus *eventbus.Bus, lruSize int) *BatchCollector {
	if lruSize <= 0 {
		lruSize = 1024
	}
	return &BatchCollector{
		bus:     bus,
		lru:     list.New(),
		batches: make(map[string]*list.Element, lruSize),
		lruSize: lruSize,
	}
}

// Start subscribes to EventExecCompleted and EventExecBatchFailed. Returns
// nil on success. When ctx is cancelled, the bus subscriptions are torn
// down via the cancel funcs returned by Subscribe.
func (bc *BatchCollector) Start(ctx context.Context) error {
	bc.cancels = append(bc.cancels,
		bc.bus.Subscribe(eventbus.EventExecCompleted, func(e eventbus.Event) {
			bc.handleCompleted(e)
		}),
		bc.bus.Subscribe(eventbus.EventExecBatchFailed, func(e eventbus.Event) {
			bc.handleBatchFailed(e)
		}),
	)

	go func() {
		<-ctx.Done()
		for _, cancel := range bc.cancels {
			cancel()
		}
	}()
	return nil
}

// Submit registers a new batch and returns a receive-only channel that
// closes when the batch settles. Step 9's tool handler blocks on this
// channel after publishing the per-command EventExecRequested events.
//
// If a batch with the same ID is already registered, the existing abortCh
// is returned (Submit is idempotent for the same batchID) and a warning
// is logged. The LRU position is not touched.
func (bc *BatchCollector) Submit(ctx context.Context, batchID string, expected int, failFast bool) <-chan struct{} {
	bc.mu.Lock()
	defer bc.mu.Unlock()

	if elem, ok := bc.batches[batchID]; ok {
		state := elem.Value.(*batchState)
		slog.LogAttrs(ctx, slog.LevelWarn, "batch_collector: duplicate submit",
			slog.String("batch_id", batchID),
			slog.Int("received", state.received),
			slog.Int("expected", state.expected),
			slog.Bool("failed", state.failed),
		)
		return state.abortCh
	}

	if expected <= 0 {
		slog.LogAttrs(ctx, slog.LevelWarn, "batch_collector: non-positive expected count, batch will settle immediately",
			slog.String("batch_id", batchID),
			slog.Int("received", 0),
			slog.Int("expected", expected),
			slog.Bool("failed", false),
		)
	}

	state := &batchState{
		batchID:  batchID,
		expected: expected,
		failFast: failFast,
		results:  make(map[string]*ExecResult, max(expected, 1)),
		abortCh:  make(chan struct{}),
	}
	elem := bc.lru.PushBack(state)
	bc.batches[batchID] = elem

	// LRU eviction: drop the oldest entries when over capacity. If an evicted
	// batch was still open, log a warning — late events for it will be
	// dropped with "reason=late_event".
	for bc.lru.Len() > bc.lruSize {
		front := bc.lru.Front()
		oldState := front.Value.(*batchState)
		bc.lru.Remove(front)
		delete(bc.batches, oldState.batchID)
		if !oldState.settled() {
			slog.LogAttrs(ctx, slog.LevelWarn, "batch_collector: evicted unsettled batch",
				slog.String("batch_id", oldState.batchID),
				slog.Int("received", oldState.received),
				slog.Int("expected", oldState.expected),
				slog.Bool("failed", oldState.failed),
			)
		}
	}

	slog.LogAttrs(ctx, slog.LevelInfo, "batch_collector: registered batch",
		slog.String("batch_id", batchID),
		slog.Int("received", 0),
		slog.Int("expected", expected),
		slog.Bool("failed", false),
	)
	return state.abortCh
}

// Result returns the current result snapshot for a batch. Callers typically
// call this after the channel returned by Submit has closed.
func (bc *BatchCollector) Result(batchID string) (*BatchCompletionPayload, error) {
	bc.mu.Lock()
	defer bc.mu.Unlock()

	elem, ok := bc.batches[batchID]
	if !ok {
		return nil, fmt.Errorf("batch_collector: unknown batch %q", batchID)
	}
	state := elem.Value.(*batchState)
	bc.lru.MoveToBack(elem)

	results := make(map[string]*ExecResult, len(state.results))
	for id, result := range state.results {
		results[id] = result
	}
	return &BatchCompletionPayload{
		BatchID: batchID,
		Results: results,
		Failed:  state.failed,
		Reason:  state.reason,
	}, nil
}

// Abort marks a batch as failed and publishes EventExecBatchFailed. It is
// idempotent and safe to call from multiple HTTP requests for the same
// batchID (Step 12's `/exec-batch/:id/abort` route).
//
// Returns an error if the batch is unknown (never registered or already
// LRU-evicted). Calling Abort on a settled batch is a no-op and returns
// nil.
func (bc *BatchCollector) Abort(ctx context.Context, batchID string, reason string) error {
	bc.mu.Lock()
	defer bc.mu.Unlock()

	elem, ok := bc.batches[batchID]
	if !ok {
		return fmt.Errorf("batch_collector: unknown batch %q", batchID)
	}
	state := elem.Value.(*batchState)
	bc.lru.MoveToBack(elem) // touch on access

	state.doneOnce.Do(func() {
		state.failed = true
		state.reason = reason
		bc.bus.Publish(eventbus.EventExecBatchFailed, &BatchCompletionPayload{
			BatchID: batchID,
			Results: state.results,
			Failed:  true,
			Reason:  reason,
		})
		close(state.abortCh)
	})

	slog.LogAttrs(ctx, slog.LevelInfo, "batch_collector: aborted",
		slog.String("batch_id", batchID),
		slog.Int("received", state.received),
		slog.Int("expected", state.expected),
		slog.Bool("failed", state.failed),
	)
	return nil
}

// handleCompleted is the bus handler for EventExecCompleted. Runs on the
// bus goroutine — must not block.
func (bc *BatchCollector) handleCompleted(e eventbus.Event) {
	result, ok := e.Payload.(*ExecResult)
	if !ok || result == nil {
		slog.Warn("batch_collector: invalid completed payload", "type", fmt.Sprintf("%T", e.Payload))
		return
	}
	if result.ID == "" {
		slog.Warn("batch_collector: completed event missing exec ID")
		return
	}
	if result.BatchID == "" {
		slog.LogAttrs(context.Background(), slog.LevelWarn, "batch_collector: completed event missing batch_id",
			slog.String("batch_id", ""),
			slog.Int("received", 0),
			slog.Int("expected", 0),
			slog.Bool("failed", false),
			slog.String("exec_id", result.ID),
		)
		return
	}

	bc.mu.Lock()
	defer bc.mu.Unlock()

	elem, ok := bc.batches[result.BatchID]
	if !ok {
		// Post-eviction or unknown batch: late event.
		slog.LogAttrs(context.Background(), slog.LevelWarn, "batch_collector: late event",
			slog.String("reason", "late_event"),
			slog.String("batch_id", result.BatchID),
			slog.Int("received", 0),
			slog.Int("expected", 0),
			slog.Bool("failed", false),
		)
		return
	}
	state := elem.Value.(*batchState)
	bc.lru.MoveToBack(elem) // touch on access

	if state.settled() {
		// Batch already settled (completed or failed); this completion is
		// stale. Still useful to log so operators can spot extra events.
		slog.LogAttrs(context.Background(), slog.LevelWarn, "batch_collector: late event",
			slog.String("reason", "batch_settled"),
			slog.String("batch_id", result.BatchID),
			slog.Int("received", state.received),
			slog.Int("expected", state.expected),
			slog.Bool("failed", state.failed),
		)
		return
	}

	// De-dupe by exec ID — if the same completion fires twice, ignore the
	// second (the sender might be retrying; idempotency matters here so
	// received does not exceed expected).
	if _, dup := state.results[result.ID]; !dup {
		state.results[result.ID] = result
		state.received++
	}

	// Fail-fast: any non-ok completion short-circuits the batch. We do NOT
	// wait for the remaining commands; they will arrive later and be
	// dropped with "reason=batch_settled".
	if state.failFast && result.Status != "ok" {
		state.failed = true
		state.reason = fmt.Sprintf("fail_fast: exec %q status=%q", result.ID, result.Status)
		state.doneOnce.Do(func() {
			bc.bus.Publish(eventbus.EventExecBatchFailed, &BatchCompletionPayload{
				BatchID: result.BatchID,
				Results: state.results,
				Failed:  true,
				Reason:  state.reason,
			})
			close(state.abortCh)
		})
		slog.LogAttrs(context.Background(), slog.LevelInfo, "batch_collector: fail-fast triggered",
			slog.String("batch_id", result.BatchID),
			slog.Int("received", state.received),
			slog.Int("expected", state.expected),
			slog.Bool("failed", true),
		)
		return
	}

	// Happy path: all N completions arrived.
	if state.received >= state.expected && state.expected > 0 {
		state.doneOnce.Do(func() {
			bc.bus.Publish(eventbus.EventExecBatchCompleted, &BatchCompletionPayload{
				BatchID: result.BatchID,
				Results: state.results,
				Failed:  false,
			})
			close(state.abortCh)
		})
		slog.LogAttrs(context.Background(), slog.LevelInfo, "batch_collector: batch completed",
			slog.String("batch_id", result.BatchID),
			slog.Int("received", state.received),
			slog.Int("expected", state.expected),
			slog.Bool("failed", false),
		)
		return
	}

	slog.LogAttrs(context.Background(), slog.LevelDebug, "batch_collector: progress",
		slog.String("batch_id", result.BatchID),
		slog.Int("received", state.received),
		slog.Int("expected", state.expected),
		slog.Bool("failed", state.failed),
	)
}

// handleBatchFailed is the bus handler for EventExecBatchFailed (e.g. from
// Step 12's HTTP abort route). Runs on the bus goroutine — must not block.
func (bc *BatchCollector) handleBatchFailed(e eventbus.Event) {
	payload, ok := e.Payload.(*BatchCompletionPayload)
	if !ok || payload == nil || payload.BatchID == "" {
		slog.Warn("batch_collector: invalid batch_failed payload", "type", fmt.Sprintf("%T", e.Payload))
		return
	}

	bc.mu.Lock()
	defer bc.mu.Unlock()

	elem, ok := bc.batches[payload.BatchID]
	if !ok {
		slog.LogAttrs(context.Background(), slog.LevelWarn, "batch_collector: late event",
			slog.String("reason", "late_event"),
			slog.String("batch_id", payload.BatchID),
			slog.Int("received", 0),
			slog.Int("expected", 0),
			slog.Bool("failed", true),
		)
		return
	}
	state := elem.Value.(*batchState)
	bc.lru.MoveToBack(elem)

	state.failed = true
	state.reason = payload.Reason
	state.doneOnce.Do(func() {
		// Re-publish the payload (or merge) so any subscriber (e.g. Step 9's
		// tool handler) gets the signal. The same payload type is used for
		// both EventExecBatchCompleted and EventExecBatchFailed, so the
		// handler can read Results + Reason uniformly.
		merged := &BatchCompletionPayload{
			BatchID: payload.BatchID,
			Results: state.results,
			Failed:  true,
			Reason:  payload.Reason,
		}
		if merged.Reason == "" {
			merged.Reason = "external batch_failed event"
		}
		state.reason = merged.Reason
		bc.bus.Publish(eventbus.EventExecBatchFailed, merged)
		close(state.abortCh)
	})

	slog.LogAttrs(context.Background(), slog.LevelInfo, "batch_collector: external batch_failed",
		slog.String("batch_id", payload.BatchID),
		slog.Int("received", state.received),
		slog.Int("expected", state.expected),
		slog.Bool("failed", true),
	)
}
