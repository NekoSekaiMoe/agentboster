//go:build linux
// +build linux

package sandbox

import (
	"testing"
	"time"
)

func TestNewHealthChecker_DefaultsWhenZero(t *testing.T) {
	h := NewHealthChecker(&Manager{}, 0, 0)
	if h.interval != defaultHealthCheckInterval {
		t.Errorf("interval = %v; want %v", h.interval, defaultHealthCheckInterval)
	}
	if h.failureThreshold != defaultHealthCheckFailureThreshold {
		t.Errorf("threshold = %v; want %v", h.failureThreshold, defaultHealthCheckFailureThreshold)
	}
}

func TestHealthChecker_FailureCounter_TakesThresholdToReap(t *testing.T) {
	h := NewHealthChecker(&Manager{}, time.Hour, 3)

	// First failure: counter goes to 1, must not trip reap.
	if c := h.bumpFailure("sb-1"); c != 1 {
		t.Fatalf("first bump = %v; want 1", c)
	}
	if c := h.bumpFailure("sb-1"); c != 2 {
		t.Fatalf("second bump = %v; want 2", c)
	}
	if c := h.bumpFailure("sb-1"); c != 3 {
		t.Fatalf("third bump = %v; want 3", c)
	}

	// ReapedCount stays 0 here — we only count actual reaps in probeOne,
	// not bumps. So this test focuses on the counter behavior, which is
	// what keeps us from reaping on a one-off Status blip.
	if h.ReapedCount() != 0 {
		t.Fatalf("ReapedCount not bumped by bumps alone")
	}

	// reset clears the slate for that id only.
	h.bumpFailure("sb-2")
	h.resetFailure("sb-1")
	if c := h.bumpFailure("sb-1"); c != 1 {
		t.Fatalf("post-reset bump = %v; want 1", c)
	}
	if c := h.bumpFailure("sb-2"); c != 2 {
		t.Fatalf("sb-2 unaffected by sb-1 reset; want 2, got %v", c)
	}
}

func TestHealthChecker_StopIsIdempotent(t *testing.T) {
	h := NewHealthChecker(&Manager{}, 0, 0)
	h.Stop()
	// Second Stop must not panic (close of closed channel).
	h.Stop()
}

func TestHealthChecker_Tick_EmptyManagerIsNoop(t *testing.T) {
	h := NewHealthChecker(&Manager{}, 0, 0)
	// No sandboxes registered: tick must not panic.
	h.tick()
	if h.ReapedCount() != 0 {
		t.Fatalf("ReapedCount = %v; want 0", h.ReapedCount())
	}
}

func TestHealthChecker_ProbeOne_NotFoundResetsFailure(t *testing.T) {
	m := &Manager{
		sandboxes: make(map[string]*Sandbox),
		providers: make(map[string]SandboxProvider),
	}
	h := NewHealthChecker(m, 0, 0)

	// Pre-seed a failure count; probe against a sandbox that doesn't
	// exist in the map must clear it.
	h.bumpFailure("ghost")
	h.probeOne("ghost")

	h.mu.Lock()
	_, stillThere := h.failures["ghost"]
	h.mu.Unlock()
	if stillThere {
		t.Fatal("probeOne on missing sandbox must reset failure counter")
	}
}
