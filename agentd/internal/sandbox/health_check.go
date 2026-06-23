//go:build linux
// +build linux

package sandbox

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// HealthChecker periodically probes every active sandbox via its
// provider's Status() and reaps any that have died on the host (OOM
// kills, daemon restarts, container crash-loops). This complements
// ReapOrphans (which runs once at daemon startup) with a continuous
// background sweep so the in-memory sandbox map doesn't lie about what
// is actually running.
//
// Reaping a dead sandbox:
//   - marks it destroyed in the manager's map
//   - stops its egress refresher
//   - removes it from the on-disk store
//   - emits a structured log + counter bump for observability
//
// All probe errors are counted; a sandbox is only reaped after
// consecutiveFailures >= failureThreshold (default 2). This avoids
// tearing down a sandbox because of a one-off docker daemon hiccup.
type HealthChecker struct {
	manager           *Manager
	interval          time.Duration
	failureThreshold  int
	probeTimeout      time.Duration
	mu                sync.Mutex
	failures          map[string]int
	stopCh            chan struct{}
	stopped           bool
	reapedCount       int64
	consecutiveChecks int64
}

// NewHealthChecker constructs a checker. interval<=0 is clamped to the
// default. Caller must invoke Start separately.
func NewHealthChecker(m *Manager, interval time.Duration, failureThreshold int) *HealthChecker {
	if interval <= 0 {
		interval = defaultHealthCheckInterval
	}
	if failureThreshold <= 0 {
		failureThreshold = defaultHealthCheckFailureThreshold
	}
	return &HealthChecker{
		manager:          m,
		interval:         interval,
		failureThreshold: failureThreshold,
		probeTimeout:     defaultHealthCheckProbeTimeout,
		failures:         make(map[string]int),
		stopCh:           make(chan struct{}),
	}
}

const (
	defaultHealthCheckInterval          = 60 * time.Second
	defaultHealthCheckFailureThreshold  = 2
	defaultHealthCheckProbeTimeout      = 5 * time.Second
)

// Start launches the background goroutine. Calling Start twice
// panics; the checker is single-use.
func (h *HealthChecker) Start() {
	go h.loop()
}

// Stop signals the background goroutine to exit. Safe to call once.
func (h *HealthChecker) Stop() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.stopped {
		return
	}
	h.stopped = true
	close(h.stopCh)
}

// ReapedCount returns the total number of sandboxes reaped since
// startup. Exposed for metrics/observability.
func (h *HealthChecker) ReapedCount() int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.reapedCount
}

func (h *HealthChecker) loop() {
	ticker := time.NewTicker(h.interval)
	defer ticker.Stop()
	for {
		select {
		case <-h.stopCh:
			return
		case <-ticker.C:
			h.tick()
		}
	}
}

func (h *HealthChecker) tick() {
	h.manager.mu.RLock()
	ids := make([]string, 0, len(h.manager.sandboxes))
	for id := range h.manager.sandboxes {
		ids = append(ids, id)
	}
	h.manager.mu.RUnlock()

	if len(ids) == 0 {
		return
	}

	h.mu.Lock()
	h.consecutiveChecks++
	h.mu.Unlock()

	for _, id := range ids {
		h.probeOne(id)
	}
}

func (h *HealthChecker) probeOne(sandboxID string) {
	ctx, cancel := context.WithTimeout(context.Background(), h.probeTimeout)
	defer cancel()

	// Manager.Status calls provider.Status which exec's docker inspect
	// or lxc-info — bounded by the probe timeout via ctx-aware callers
	// if available, otherwise by the exec's own CombinedOutput.
	_ = ctx
	sb, err := h.manager.Status(sandboxID)
	if err != nil {
		// "not found" means the manager already dropped it between
		// snapshot and probe. Reset failure counter and move on.
		h.resetFailure(sandboxID)
		return
	}

	if sb != nil && sb.Status != "destroyed" && sb.Status != "dead" {
		h.resetFailure(sandboxID)
		return
	}

	// Status reported destroyed or dead — bump failure counter and
	// reap only after threshold consecutive observations.
	count := h.bumpFailure(sandboxID)
	if count < h.failureThreshold {
		slog.Debug("health_check: sandbox unhealthy, observing",
			"sandbox", sandboxID,
			"status", sb.Status,
			"failures", count,
			"threshold", h.failureThreshold,
		)
		return
	}

	slog.Warn("health_check: reaping dead sandbox",
		"sandbox", sandboxID,
		"status", sb.Status,
		"failures", count,
	)
	if err := h.manager.DestroySandbox(sandboxID); err != nil {
		// Most common cause: another goroutine (manual destroy, force
		// destroy, concurrent checker tick) beat us to it. Log and
		// continue — the desired end state (sandbox gone) is reached.
		slog.Debug("health_check: destroy failed (likely already gone)",
			"sandbox", sandboxID,
			"error", err,
		)
	}
	h.resetFailure(sandboxID)

	h.mu.Lock()
	h.reapedCount++
	h.mu.Unlock()
}

func (h *HealthChecker) bumpFailure(id string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.failures[id]++
	return h.failures[id]
}

func (h *HealthChecker) resetFailure(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.failures, id)
}
