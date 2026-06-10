package security

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/eventbus"
	"github.com/clawless/agentd/internal/security/l0_rules"
	"github.com/clawless/agentd/internal/security/l2_auth"
)

// ReviewDecision represents the outcome of a security review.
type ReviewDecision string

const (
	DecisionAllowed        ReviewDecision = "allowed"
	DecisionBlocked        ReviewDecision = "blocked"
	DecisionPendingConfirm ReviewDecision = "pending_confirm"
)

// ReviewResult holds the full review result from all tiers.
type ReviewResult struct {
	Decision ReviewDecision
	L0Result *l0_rules.L0Result
	L1Result *clawless.L1Result
	TaskID   string
	Command  string
	Reason   string
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
	l0        *l0_rules.Engine
	l1        clawless.L1Scorer
	l2        *l2_auth.L2AuthManager
	bus       *eventbus.Bus
	agentID   string
	l1Enabled bool
	failOpen  bool
}

type GatekeeperOptions struct {
	L1Enabled bool
	FailOpen  bool
}

type deterministicL2Pattern struct {
	reason string
	re     *regexp.Regexp
}

var deterministicL2Patterns = []deterministicL2Pattern{
	{
		reason: "uses shred to overwrite file contents",
		re:     regexp.MustCompile(`(?is)(^|[^\w./-])shred([^\w./-]|$)`),
	},
	{
		reason: "uses find -exec with a destructive command",
		re:     regexp.MustCompile(`(?is)\bfind\b.*\s-exec\s+.*\b(?:rm|shred|dd|truncate|wipefs)\b`),
	},
	{
		reason: "uses find -delete for bulk deletion",
		re:     regexp.MustCompile(`(?is)\bfind\b.*\s-delete\b`),
	},
	{
		reason: "pipes file lists into a destructive command",
		re:     regexp.MustCompile(`(?is)\bxargs\b.*\b(?:rm|shred|dd|truncate|wipefs)\b`),
	},
	{
		reason: "uses an interpreter one-liner for destructive filesystem changes",
		re:     regexp.MustCompile(`(?is)\b(?:perl|ruby|node)\b.*\s-e\s+.*\b(?:unlink|rmtree|remove_tree|rm\s+-rf|shred)\b`),
	},
	{
		reason: "uses a Python one-liner for destructive filesystem changes",
		re:     regexp.MustCompile(`(?is)\bpython3?\b.*\s-c\s+.*\b(?:shutil\.rmtree|os\.(?:remove|unlink)|rm\s+-rf|shred)\b`),
	},
}

// NewGatekeeper creates a new Gatekeeper with all three tiers.
func NewGatekeeper(
	l0 *l0_rules.Engine,
	l1 clawless.L1Scorer,
	l2 *l2_auth.L2AuthManager,
	bus *eventbus.Bus,
	agentID string,
	options GatekeeperOptions,
) *Gatekeeper {
	return &Gatekeeper{
		l0:        l0,
		l1:        l1,
		l2:        l2,
		bus:       bus,
		agentID:   agentID,
		l1Enabled: options.L1Enabled,
		failOpen:  options.FailOpen,
	}
}

func deterministicL2Reason(command string) (string, bool) {
	for _, pattern := range deterministicL2Patterns {
		if pattern.re.MatchString(command) {
			return pattern.reason, true
		}
	}
	return "", false
}

func hardenL1Result(command string, l1 *clawless.L1Result) *clawless.L1Result {
	if l1 == nil {
		return &clawless.L1Result{
			Score:  0.8,
			Level:  "high",
			Reason: "L1 returned no result, requiring L2 authorization",
		}
	}

	hardened := *l1
	switch hardened.Level {
	case "low", "medium", "high", "critical":
	default:
		hardened.Score = maxFloat(hardened.Score, 0.8)
		hardened.Level = "high"
		hardened.Reason = appendL1Reason(
			fmt.Sprintf("unknown L1 level %q, requiring L2 authorization", l1.Level),
			l1.Reason,
		)
	}

	if reason, ok := deterministicL2Reason(command); ok && hardened.Level != "high" && hardened.Level != "critical" {
		hardened.Score = maxFloat(hardened.Score, 0.8)
		hardened.Level = "high"
		hardened.Reason = appendL1Reason("deterministic L2 risk: "+reason, l1.Reason)
	}

	return &hardened
}

func appendL1Reason(prefix, existing string) string {
	existing = strings.TrimSpace(existing)
	if existing == "" {
		return prefix
	}
	return prefix + "; L1: " + existing
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
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
		decision := "blocked"
		if g.failOpen {
			decision = "allowed"
			logs = append(logs, result.ReviewLog("L0", 0, decision, "L0 check error: "+err.Error()))
		} else {
			result.Decision = DecisionBlocked
			result.Reason = "L0 engine error: " + err.Error()
			logs = append(logs, result.ReviewLog("L0", 1.0, decision, result.Reason))
			return result, logs
		}
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

	if !g.l1Enabled {
		result.Decision = DecisionAllowed
		result.Reason = "L1 disabled by configuration"
		return result, logs
	}

	// === Tier 2: L1 Scorer ===
	slog.Info("Gatekeeper: L1 review", "task_id", task.ID)
	l1Result, err := g.l1.Score(ctx, task.Command, "", sessionSummary)
	if err != nil {
		slog.Error("L1 scoring error", "task_id", task.ID, "error", err)
		if !g.failOpen {
			result.Decision = DecisionBlocked
			result.Reason = "L1 scoring error: " + err.Error()
			logs = append(logs, result.ReviewLog("L1", 1.0, "blocked", result.Reason))
			return result, logs
		}
		logs = append(logs, result.ReviewLog("L1", 0.3, "allowed", "L1 scoring error: "+err.Error()))
		l1Result = &clawless.L1Result{Score: 0.3, Level: "medium", Reason: "scoring error, fail_open=true"}
	}

	l1Result = hardenL1Result(task.Command, l1Result)
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

		return g.requestL2Auth(task, l1Result, result, logs), logs

	case l1Result.Level == "critical":
		// Critical risk → L2 high-severity interactive authorization
		slog.Warn("Gatekeeper: L1 critical risk, requiring L2 auth",
			"task_id", task.ID, "score", l1Result.Score, "reason", l1Result.Reason)

		return g.requestL2Auth(task, l1Result, result, logs), logs

	default:
		// hardenL1Result converts unknown levels to high. Keep this branch
		// defensive in case new levels are introduced without updating it.
		l1Result.Level = "high"
		l1Result.Score = maxFloat(l1Result.Score, 0.8)
		l1Result.Reason = appendL1Reason("unknown L1 level, requiring L2 authorization", l1Result.Reason)
		return g.requestL2Auth(task, l1Result, result, logs), logs
	}
}

func l1ScoreToFloat(r *clawless.L1Result) float64 {
	if r == nil {
		return 0
	}
	return r.Score
}

func l1Action(r *clawless.L1Result) string {
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
	case "critical":
		return "pending_l2_critical"
	default:
		return "allowed"
	}
}

// AuditOutput validates LLM output content through the security pipeline.
// L0 checks for known leak patterns, L1 scores for anomalous output.
func (g *Gatekeeper) AuditOutput(ctx context.Context, output string, sessionSummary string) (*ReviewResult, []clawless.ReviewLog) {
	result := &ReviewResult{
		Command: output,
	}
	logs := make([]clawless.ReviewLog, 0, 2)

	// === L0 Output Check ===
	l0Result := g.l0.CheckOutput(output)
	if l0Result != nil && l0Result.Blocked {
		result.Decision = DecisionBlocked
		result.Reason = "L0 output block: " + l0Result.Reason
		result.L0Result = l0Result
		logs = append(logs, result.ReviewLog("L0-output", 1.0, "blocked", l0Result.Reason))

		g.bus.Publish(eventbus.EventSecurityAlert, map[string]any{
			"level":    "L0-output",
			"decision": "blocked",
			"reason":   l0Result.Reason,
			"rule_id":  l0Result.Rule.ID,
		})
		return result, logs
	}

	// === L1 Output Score ===
	l1Result, err := g.l1.ScoreOutput(ctx, output, sessionSummary)
	if err != nil {
		slog.Error("L1 output scoring error", "error", err)
		logs = append(logs, result.ReviewLog("L1-output", 0.3, "allowed", "L1 output scoring error"))
		result.Decision = DecisionAllowed
		result.Reason = "L1 output scoring error, defaulting to allow"
		return result, logs
	}

	result.L1Result = l1Result
	logs = append(logs, result.ReviewLog("L1-output", l1ScoreToFloat(l1Result), l1Action(l1Result), l1Result.Reason))

	switch {
	case l1Result.Level == "high" || l1Result.Level == "critical":
		result.Decision = DecisionBlocked
		result.Reason = "L1 output risk: " + l1Result.Reason
		g.bus.Publish(eventbus.EventSecurityAlert, map[string]any{
			"level":    "L1-output",
			"score":    l1Result.Score,
			"decision": "blocked",
			"reason":   l1Result.Reason,
		})
	case l1Result.Level == "medium":
		result.Decision = DecisionAllowed
		result.Reason = "L1 output medium risk, allowing with warning: " + l1Result.Reason
	default:
		result.Decision = DecisionAllowed
		result.Reason = "output safe"
	}

	return result, logs
}

// requestL2Auth handles the L2 authorization flow for high/critical risk commands.
func (g *Gatekeeper) requestL2Auth(task *clawless.Task, l1Result *clawless.L1Result, result *ReviewResult, logs []clawless.ReviewLog) *ReviewResult {
	// Check L2 cache
	if entry, hit, rejected := g.l2.CheckTask(task); hit {
		if rejected {
			slog.Info("Gatekeeper: L2 cache reject", "task_id", task.ID, "pattern", entry.Pattern)
			result.Decision = DecisionBlocked
			result.Reason = "L2: rejected by cache"
			return result
		}
		slog.Info("Gatekeeper: L2 cache hit", "task_id", task.ID, "pattern", entry.Pattern)
		result.Decision = DecisionAllowed
		result.Reason = "L2: cached authorization"
		return result
	}

	// Request L2 authorization
	g.l2.RememberPendingTask(task)
	result.Decision = DecisionPendingConfirm
	result.Reason = "L2: awaiting user authorization"

	g.bus.Publish(eventbus.EventL2AuthRequired, map[string]any{
		"task_id": task.ID,
		"command": task.Command,
		"score":   l1Result.Score,
		"reason":  l1Result.Reason,
		"level":   l1Result.Level,
		"task":    task,
		"source":  task.Source,
		"user_id": task.UserID,
		"message": l2_auth.FormatNotificationMessage(task.Command, l1Result.Score, l1Result.Reason, l1Result.Level),
	})

	return result
}

const batchTokenBombLimit = 4096

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// batchTaskID synthesises a per-cmd identifier for audit events. Real exec
// commands will later carry their own IDs (set by the exec_batch tool), but
// the audit step needs a stable, traceable key for the L2/L1 events.
func batchTaskID(sessionID string, index int) string {
	return fmt.Sprintf("%s:batch:%d", sessionID, index)
}

// runL1Batch calls the batched L1 scorer for a list of commands that have
// already passed L0. If the batched call fails (HTTP, parse, or token-bomb)
// the method falls back to per-cmd Score sequentially so callers always get
// a fully-populated result slice. The returned usedFallback flag is included
// in the "L1 batched score" log line for observability.
func (g *Gatekeeper) runL1Batch(
	ctx context.Context,
	commands []string,
	workDir string,
	sessionSummary string,
) ([]*clawless.L1Result, bool) {
	start := time.Now()
	results, err := g.l1.ScoreBatch(ctx, commands, sessionSummary)
	elapsed := time.Since(start)

	usedFallback := false
	if err != nil {
		usedFallback = true
		slog.Warn("L1 batched score failed, falling back to per-cmd",
			slog.String("fallback_reason", err.Error()),
			slog.Int("batch_size", len(commands)),
		)
		results = make([]*clawless.L1Result, len(commands))
		for i, cmd := range commands {
			r, sErr := g.l1.Score(ctx, cmd, workDir, sessionSummary)
			if sErr != nil {
				// L1Client.Score never returns an error (it fails open with
				// medium), but stay defensive in case a mock implementation
				// propagates.
				slog.Error("L1 per-cmd fallback error",
					slog.Int("index", i),
					slog.String("command", truncate(cmd, 80)),
					slog.String("error", sErr.Error()),
				)
				r = &clawless.L1Result{
					Score:  0.3,
					Level:  "medium",
					Reason: "l1_percmd_fallback_error",
				}
			}
			results[i] = r
		}
	}

	blockedCount := 0
	for _, r := range results {
		if r == nil {
			continue
		}
		if r.Level == "high" || r.Level == "critical" {
			blockedCount++
		}
	}

	slog.LogAttrs(ctx, slog.LevelInfo, "L1 batched score",
		slog.Int("batch_size", len(commands)),
		slog.Int("l1_blocked_count", blockedCount),
		slog.Duration("l1_latency_ms", elapsed),
		slog.Bool("fallback", usedFallback),
	)

	return results, usedFallback
}

// applyL1Result updates the per-cmd result with the L1 decision and (for
// medium/high/critical) the corresponding observability event. Missing,
// unknown, or deterministically risky L1 results require L2 authorization.
func (g *Gatekeeper) applyL1Result(taskID, command string, r *ReviewResult, l1 *clawless.L1Result) {
	l1 = hardenL1Result(command, l1)
	r.L1Result = l1

	switch l1.Level {
	case "low":
		r.Decision = DecisionAllowed
		r.Reason = "L1: low risk"
	case "medium":
		r.Decision = DecisionAllowed
		r.Reason = "L1: medium risk, notified user"
		g.bus.Publish(eventbus.EventSecurityAlert, map[string]any{
			"task_id":  taskID,
			"level":    "L1",
			"score":    l1.Score,
			"decision": "allowed_with_warning",
			"reason":   l1.Reason,
			"command":  command,
		})
	case "high", "critical":
		// Decision/Reason are filled in by the L2 step; leave the result
		// in a "needs L2" state for the L2 step to finalize.
	default:
		l1.Level = "high"
		l1.Score = maxFloat(l1.Score, 0.8)
		l1.Reason = appendL1Reason("unknown L1 level, requiring L2 authorization", l1.Reason)
	}
}

// applyL2Cache checks the L2 cache for the command. Returns true if the
// decision was finalised (allow or reject) by the cache; false if the
// command still needs a user prompt.
func (g *Gatekeeper) applyL2Cache(command string, r *ReviewResult) bool {
	entry, hit, rejected := g.l2.Check(command)
	if !hit {
		return false
	}
	if rejected {
		slog.Info("Gatekeeper: L2 cache reject",
			"task_id", r.TaskID,
			"pattern", entry.Pattern,
		)
		r.Decision = DecisionBlocked
		r.Reason = "L2: rejected by cache"
		return true
	}
	slog.Info("Gatekeeper: L2 cache hit",
		"task_id", r.TaskID,
		"pattern", entry.Pattern,
	)
	r.Decision = DecisionAllowed
	r.Reason = "L2: cached authorization"
	return true
}

// AuditBatch runs the three-tier security review across a list of commands.
// L0 is applied per-command (cheap and correctness-critical). L1 is batched
// into a single LLM call (with per-cmd fallback on failure). L2 is applied
// per-command for those whose L1 score warrants user authorization.
// The returned slice has the same length and order as the input.
func (g *Gatekeeper) AuditBatch(ctx context.Context, sessionID, workDir, summary string, commands []string) []ReviewResult {
	results := make([]ReviewResult, len(commands))
	for i, cmd := range commands {
		results[i] = ReviewResult{
			TaskID:  batchTaskID(sessionID, i),
			Command: cmd,
		}
	}

	// === Tier 1: L0 per-cmd (parallel) ===
	var wg sync.WaitGroup
	for i := range commands {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			cmd := commands[i]
			l0Result, err := g.l0.Check(cmd, workDir)
			if err != nil {
				slog.Warn("Gatekeeper: L0 check error in batch",
					"index", i,
					"command", truncate(cmd, 80),
					"error", err,
				)
				return
			}
			if l0Result == nil || !l0Result.Blocked {
				return
			}
			results[i].L0Result = l0Result
			results[i].Decision = DecisionBlocked
			results[i].Reason = l0Result.Reason
			g.bus.Publish(eventbus.EventSecurityAlert, map[string]any{
				"task_id":  results[i].TaskID,
				"level":    "L0",
				"decision": "blocked",
				"reason":   l0Result.Reason,
				"command":  cmd,
				"rule_id":  l0Result.Rule.ID,
			})
		}(i)
	}
	wg.Wait()

	// === Tier 2: L1 batched ===
	// Build the L1 input as the commands whose L0 decision is still empty.
	// The parallel `pendingIdx` aligns results back to the original indices.
	var pendingIdx []int
	var pendingCmds []string
	for i, r := range results {
		if r.Decision == "" {
			pendingIdx = append(pendingIdx, i)
			pendingCmds = append(pendingCmds, commands[i])
		}
	}

	if len(pendingCmds) > 0 {
		// Token-bomb guard: if the per-cmd characters exceed the cap, fall
		// back to per-cmd scoring instead of building a huge batched prompt.
		totalLen := 0
		for _, c := range pendingCmds {
			totalLen += len(c)
		}
		var l1Results []*clawless.L1Result
		if totalLen > batchTokenBombLimit {
			slog.Warn("L1 batched score skipped: token-bomb guard tripped, falling back to per-cmd",
				"total_chars", totalLen,
				"limit", batchTokenBombLimit,
				"batch_size", len(pendingCmds),
			)
			l1Results = make([]*clawless.L1Result, len(pendingCmds))
			start := time.Now()
			for j, c := range pendingCmds {
				r, sErr := g.l1.Score(ctx, c, workDir, summary)
				if sErr != nil {
					r = &clawless.L1Result{Score: 0.3, Level: "medium", Reason: "l1_percmd_fallback_error"}
				}
				l1Results[j] = r
			}
			blockedCount := 0
			for _, r := range l1Results {
				if r != nil && (r.Level == "high" || r.Level == "critical") {
					blockedCount++
				}
			}
			slog.LogAttrs(ctx, slog.LevelInfo, "L1 batched score",
				slog.Int("batch_size", len(pendingCmds)),
				slog.Int("l1_blocked_count", blockedCount),
				slog.Duration("l1_latency_ms", time.Since(start)),
				slog.Bool("fallback", true),
			)
		} else {
			l1Results, _ = g.runL1Batch(ctx, pendingCmds, workDir, summary)
		}

		for j, idx := range pendingIdx {
			var l1 *clawless.L1Result
			if j < len(l1Results) {
				l1 = l1Results[j]
			}
			g.applyL1Result(results[idx].TaskID, commands[idx], &results[idx], l1)
		}
	}

	// === Tier 3: L2 per-cmd ===
	for i := range results {
		r := &results[i]
		if r.Decision == DecisionBlocked {
			continue
		}
		l1 := r.L1Result
		if l1 == nil {
			continue
		}
		if l1.Level != "high" && l1.Level != "critical" {
			continue
		}
		if g.applyL2Cache(commands[i], r) {
			continue
		}
		r.Decision = DecisionPendingConfirm
		r.Reason = "L2: awaiting user authorization"
		g.bus.Publish(eventbus.EventL2AuthRequired, map[string]any{
			"task_id": r.TaskID,
			"command": commands[i],
			"score":   l1.Score,
			"reason":  l1.Reason,
			"level":   l1.Level,
			"message": l2_auth.FormatNotificationMessage(commands[i], l1.Score, l1.Reason, l1.Level),
		})
	}

	return results
}
