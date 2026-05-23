package security

import (
	"context"
	"log/slog"

	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/eventbus"
	"github.com/clawless/agentd/internal/security/l0_rules"
	"github.com/clawless/agentd/internal/security/l1_scorer"
	"github.com/clawless/agentd/internal/security/l2_auth"
)

// ReviewDecision represents the outcome of a security review.
type ReviewDecision string

const (
	DecisionAllowed       ReviewDecision = "allowed"
	DecisionBlocked       ReviewDecision = "blocked"
	DecisionPendingConfirm ReviewDecision = "pending_confirm"
)

// ReviewResult holds the full review result from all tiers.
type ReviewResult struct {
	Decision  ReviewDecision
	L0Result  *l0_rules.L0Result
	L1Result  *l1_scorer.L1Result
	TaskID    string
	Command   string
	Reason    string
}

// ReviewLog creates a ReviewLog from the review result.
func (r *ReviewResult) ReviewLog(level string, score float64, decision, reason string) clawless.ReviewLog {
	return clawless.ReviewLog{
		TaskID:   r.TaskID,
		Command:  r.Command,
		Level:    level,
		Score:    score,
		Decision: decision,
		Reason:   reason,
	}
}

// Gatekeeper orchestrates the three-tier security review (replicating Manboster Zero Trust).
type Gatekeeper struct {
	l0       *l0_rules.Engine
	l1       *l1_scorer.L1Scorer
	l2       *l2_auth.L2AuthManager
	bus      *eventbus.Bus
	agentID  string
}

// NewGatekeeper creates a new Gatekeeper with all three tiers.
func NewGatekeeper(
	l0 *l0_rules.Engine,
	l1 *l1_scorer.L1Scorer,
	l2 *l2_auth.L2AuthManager,
	bus *eventbus.Bus,
	agentID string,
) *Gatekeeper {
	return &Gatekeeper{
		l0:      l0,
		l1:      l1,
		l2:      l2,
		bus:     bus,
		agentID: agentID,
	}
}

// Audit runs the full three-tier review pipeline.
// Returns the decision and review logs for each tier.
func (g *Gatekeeper) Audit(ctx context.Context, task *clawless.Task, sessionSummary string) (*ReviewResult, []clawless.ReviewLog) {
	result := &ReviewResult{
		TaskID:  task.ID,
		Command: task.Command,
	}
	logs := make([]clawless.ReviewLog, 0, 3)

	// === Tier 1: L0 Rules Engine ===
	slog.Info("Gatekeeper: L0 review", "task_id", task.ID)
	l0Result, err := g.l0.Check(task.Command, "")
	if err != nil {
		slog.Error("L0 check error", "task_id", task.ID, "error", err)
		// L0 error → fail open, let L1 handle it
		logs = append(logs, result.ReviewLog("L0", 0, "allowed", "L0 check error: "+err.Error()))
	} else if l0Result != nil && l0Result.Blocked {
		result.L0Result = l0Result
		result.Decision = DecisionBlocked
		result.Reason = l0Result.Reason
		logs = append(logs, result.ReviewLog("L0", 1.0, "blocked", l0Result.Reason))

		// Publish security alert
		g.bus.Publish(eventbus.EventSecurityAlert, map[string]any{
			"task_id":  task.ID,
			"level":    "L0",
			"decision": "blocked",
			"reason":   l0Result.Reason,
			"command":  task.Command,
			"rule_id":  l0Result.Rule.ID,
		})
		return result, logs
	} else if l0Result != nil {
		// Warn — continue to L1
		logs = append(logs, result.ReviewLog("L0", 0.5, "allowed", "L0 warn: "+l0Result.Reason))
	} else {
		logs = append(logs, result.ReviewLog("L0", 0, "allowed", "no L0 rules matched"))
	}

	// === Tier 2: L1 Scorer ===
	slog.Info("Gatekeeper: L1 review", "task_id", task.ID)
	l1Result, err := g.l1.Score(ctx, task.Command, "", sessionSummary)
	if err != nil {
		slog.Error("L1 scoring error", "task_id", task.ID, "error", err)
		logs = append(logs, result.ReviewLog("L1", 0.3, "allowed", "L1 scoring error: "+err.Error()))
		// L1 error → fail open with medium score
		l1Result = &l1_scorer.L1Result{Score: 0.3, Level: "medium", Reason: "scoring error, defaulting to medium risk"}
	}

	result.L1Result = l1Result
	logs = append(logs, result.ReviewLog("L1", l1ScoreToFloat(l1Result), l1Action(l1Result), l1Result.Reason))

	switch {
	case l1Result.Level == "low":
		// Low risk → allow
		result.Decision = DecisionAllowed
		result.Reason = "L1: low risk"
		return result, logs

	case l1Result.Level == "medium":
		// Medium risk → allow but notify user (non-blocking)
		slog.Info("Gatekeeper: L1 medium risk, allowing with notification",
			"task_id", task.ID, "score", l1Result.Score, "reason", l1Result.Reason)
		result.Decision = DecisionAllowed
		result.Reason = "L1: medium risk, notified user"

		// Publish notification event (non-blocking)
		g.bus.Publish(eventbus.EventSecurityAlert, map[string]any{
			"task_id":  task.ID,
			"level":    "L1",
			"score":    l1Result.Score,
			"decision": "allowed_with_warning",
			"reason":   l1Result.Reason,
			"command":  task.Command,
		})
		return result, logs

	case l1Result.Level == "high":
		// High risk → L2 interactive authorization
		slog.Warn("Gatekeeper: L1 high risk, requiring L2 auth",
			"task_id", task.ID, "score", l1Result.Score, "reason", l1Result.Reason)

		// Check L2 cache
		if entry, ok := g.l2.Check(task.Command); ok {
			slog.Info("Gatekeeper: L2 cache hit", "task_id", task.ID, "window", entry.Window)
			result.Decision = DecisionAllowed
			result.Reason = "L2: cached authorization"
			return result, logs
		}

		// Request L2 authorization
		result.Decision = DecisionPendingConfirm
		result.Reason = "L2: awaiting user authorization"

		g.bus.Publish(eventbus.EventL2AuthRequired, map[string]any{
			"task_id":  task.ID,
			"command":  task.Command,
			"score":    l1Result.Score,
			"reason":   l1Result.Reason,
			"message":  l2_auth.FormatNotificationMessage(task.ID, task.Command, l1Result.Score, l1Result.Reason),
		})

		return result, logs

	default:
		// Unknown level → treat as medium
		result.Decision = DecisionAllowed
		result.Reason = "L1: unknown risk level, defaulting to allow"
		return result, logs
	}
}

func l1ScoreToFloat(r *l1_scorer.L1Result) float64 {
	if r == nil {
		return 0
	}
	return r.Score
}

func l1Action(r *l1_scorer.L1Result) string {
	if r == nil {
		return "allowed"
	}
	switch r.Level {
	case "low":
		return "allowed"
	case "medium":
		return "allowed_with_warning"
	case "high":
		return "pending_l2"
	default:
		return "allowed"
	}
}
