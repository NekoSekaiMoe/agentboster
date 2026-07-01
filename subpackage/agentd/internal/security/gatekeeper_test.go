//go:build linux

package security

import (
	"context"
	"testing"

	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/eventbus"
	"github.com/clawless/agentd/internal/security/l0_rules"
	"github.com/clawless/agentd/internal/security/l2_auth"
)

type mockL1Scorer struct {
	result *clawless.L1Result
	err    error
}

func (m mockL1Scorer) Score(context.Context, string, string, string) (*clawless.L1Result, error) {
	return m.result, m.err
}

func (m mockL1Scorer) ScoreOutput(context.Context, string, string) (*clawless.L1Result, error) {
	return m.result, m.err
}

func (m mockL1Scorer) ScoreBatch(context.Context, []string, string) ([]*clawless.L1Result, error) {
	return []*clawless.L1Result{m.result}, m.err
}

func TestGatekeeperL0EngineErrorFailsClosed(t *testing.T) {
	engine := l0_rules.NewEngine()
	if err := engine.AddRule(l0_rules.L0Rule{
		ID:      "bad-regex",
		Pattern: "[",
		Type:    "command",
		Action:  "block",
	}); err != nil {
		t.Fatalf("add rule: %v", err)
	}

	gk := NewGatekeeper(
		engine,
		mockL1Scorer{result: &clawless.L1Result{Score: 0.1, Level: "low", Reason: "ok"}},
		l2_auth.NewL2AuthManager(nil, "default"),
		eventbus.New(),
		"default",
		GatekeeperOptions{L1Enabled: true, FailOpen: false},
	)

	result, _ := gk.Audit(context.Background(), &clawless.Task{
		ID:      "task-1",
		Command: "echo hello",
		Roles:   []string{"user"},
	}, "")

	if result.Decision != DecisionBlocked {
		t.Fatalf("expected blocked, got %s (%s)", result.Decision, result.Reason)
	}
}

func TestGatekeeperL1UnavailableRequiresL2(t *testing.T) {
	engine := l0_rules.NewEngine()
	if err := engine.Reload(nil); err != nil {
		t.Fatalf("reload: %v", err)
	}

	gk := NewGatekeeper(
		engine,
		mockL1Scorer{result: &clawless.L1Result{Score: 0.8, Level: "high", Reason: "L1 unavailable"}},
		l2_auth.NewL2AuthManager(nil, "default"),
		eventbus.New(),
		"default",
		GatekeeperOptions{L1Enabled: true, FailOpen: false},
	)

	result, _ := gk.Audit(context.Background(), &clawless.Task{
		ID:        "task-2",
		SessionID: "session-1",
		Command:   "echo hello",
		Roles:     []string{"user"},
	}, "")

	if result.Decision != DecisionPendingConfirm {
		t.Fatalf("expected pending confirmation, got %s (%s)", result.Decision, result.Reason)
	}
}

func TestGatekeeperDeterministicRiskRequiresL2WhenL1Low(t *testing.T) {
	engine := l0_rules.NewEngine()
	if err := engine.Reload(nil); err != nil {
		t.Fatalf("reload: %v", err)
	}

	gk := NewGatekeeper(
		engine,
		mockL1Scorer{result: &clawless.L1Result{Score: 0.1, Level: "low", Reason: "looks safe"}},
		l2_auth.NewL2AuthManager(nil, "default"),
		eventbus.New(),
		"default",
		GatekeeperOptions{L1Enabled: true, FailOpen: false},
	)

	result, _ := gk.Audit(context.Background(), &clawless.Task{
		ID:        "task-3",
		SessionID: "session-1",
		Command:   `find . -type f -exec shred {} \;`,
		Roles:     []string{"user"},
	}, "")

	if result.Decision != DecisionPendingConfirm {
		t.Fatalf("expected pending confirmation, got %s (%s)", result.Decision, result.Reason)
	}
	if result.L1Result == nil || result.L1Result.Level != "high" {
		t.Fatalf("expected hardened high L1 result, got %#v", result.L1Result)
	}
}

func TestGatekeeperUnknownL1LevelRequiresL2(t *testing.T) {
	engine := l0_rules.NewEngine()
	if err := engine.Reload(nil); err != nil {
		t.Fatalf("reload: %v", err)
	}

	gk := NewGatekeeper(
		engine,
		mockL1Scorer{result: &clawless.L1Result{Score: 0.1, Level: "allow", Reason: "unexpected vocabulary"}},
		l2_auth.NewL2AuthManager(nil, "default"),
		eventbus.New(),
		"default",
		GatekeeperOptions{L1Enabled: true, FailOpen: false},
	)

	result, _ := gk.Audit(context.Background(), &clawless.Task{
		ID:        "task-4",
		SessionID: "session-1",
		Command:   "echo hello",
		Roles:     []string{"user"},
	}, "")

	if result.Decision != DecisionPendingConfirm {
		t.Fatalf("expected pending confirmation, got %s (%s)", result.Decision, result.Reason)
	}
}

func TestAuditBatchMissingL1ResultRequiresL2(t *testing.T) {
	engine := l0_rules.NewEngine()
	if err := engine.Reload(nil); err != nil {
		t.Fatalf("reload: %v", err)
	}

	gk := NewGatekeeper(
		engine,
		mockL1Scorer{result: nil},
		l2_auth.NewL2AuthManager(nil, "default"),
		eventbus.New(),
		"default",
		GatekeeperOptions{L1Enabled: true, FailOpen: false},
	)

	results := gk.AuditBatch(context.Background(), "session-1", "", "", []string{"echo hello"})
	if len(results) != 1 {
		t.Fatalf("expected one result, got %d", len(results))
	}
	if results[0].Decision != DecisionPendingConfirm {
		t.Fatalf("expected pending confirmation, got %s (%s)", results[0].Decision, results[0].Reason)
	}
}
