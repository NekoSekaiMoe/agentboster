// agentd security event schema: L0 / L1 / L2.
//
// Sources of truth (per layer):
//
//   L0:
//     - Go:  subpackage/agentd/internal/clawless/types.go:190-197
//            (minimal struct, daemon-side deny presets).
//     - TS:  lib/security/l0-engine.ts:25-33
//            (fuller interface, Web-side Vercel-Sandbox fallback gate).
//
//   L1:
//     - TS:  lib/security/l1-scorer.ts:95-122
//            (Web authoritative — scoring runs on the Web tier; the
//            daemon's `clawless/l1_client.go` is only a thin HTTP
//            client that calls back into the Web).
//     - Go:  subpackage/agentd/internal/clawless/l1_client.go:107-237
//            (wire shape for the batched endpoint, which the Web
//            side does not yet model as a TS type).
//
//   L2:
//     - TS:  lib/security/l2-decision-queue.ts:33-105
//            (Web authoritative — the queue lives on the Web tier).
//     - Go:  subpackage/agentd/internal/server/routes.go:521-528
//            (confirm wire — `action` / `pattern` / `duration`).
//     - Go:  subpackage/agentd/internal/clawless/types.go:253-260
//            (per-task `Decision` summary struct — different shape
//            from the L2 auth decision; not ported to avoid name
//            clash).
//
// Where the Web TS is fuller, it wins. Drift is reported by
// `scripts/regen-agentd.py`.

// ── L0 ────────────────────────────────────────────────────────────

// Source: subpackage/agentd/internal/clawless/types.go:190-197
// Source: lib/security/l0-engine.ts:25-33 (authoritative — fuller)
export type L0RuleType = 'command' | 'path' | 'network';
export type L0RuleAction = 'block' | 'warn';
export type L0RuleScope = 'workspace' | 'global';

/**
 * Full L0 rule. The Web TS interface is authoritative here because
 * it carries `agentId` / `enabled` / richer union types, which the
 * Go struct (used only for daemon-side deny preset storage) omits.
 *
 * Drift point: Go's `L0Rule` lacks `agentId` and `enabled`. The
 * daemon resolves agent scoping via storage keys, not the struct,
 * and treats every stored row as enabled. SDK consumers targeting
 * the daemon-side deny presets should not rely on `enabled` being
 * read back by Go.
 */
export interface L0Rule {
  id?: string;
  agentId?: string;
  pattern: string;
  type: L0RuleType;
  action: L0RuleAction;
  scope: L0RuleScope;
  enabled?: boolean;
}

// Source: lib/security/l0-engine.ts:35-42
/**
 * L0 evaluation outcome. The Web-side Vercel-Sandbox fallback gate
 * returns this; the daemon side returns a Go-native struct that
 * serializes to the same shape.
 */
export interface L0Evaluation {
  /** Whether the command should be blocked. */
  blocked: boolean;
  /** Human-readable reason for the decision (empty when allowed). */
  reason: string;
  /** The matched rule, if any (for audit logging). */
  matchedRule?: L0Rule;
}

// ── L1 ────────────────────────────────────────────────────────────

// Source: lib/security/l1-scorer.ts:95-105 (Web authoritative)
export type L1Level = 'low' | 'medium' | 'high' | 'critical';
export type L1BatchLevel = 'allow' | 'low' | 'medium' | 'high' | 'block';

/**
 * Single-command L1 score result. The schema is the authoritative
 * shape both for the Web-side scorer (`l1ScoreSchema`) and for the
 * daemon's `L1Result` struct (clawless/l1_client.go:15-20).
 */
export interface L1ScoreResult {
  /** Risk score, 0.0 = completely safe, 1.0 = extremely dangerous. */
  score: number;
  level: L1Level;
  reason: string;
}

// Source: subpackage/agentd/internal/clawless/l1_client.go:107-114
// Source: app/api/agentd/v1/l1-score/route.ts:26-44 (Web authoritative —
// zod discriminated union; the Go struct uses omitempty fields but the
// Web tier enforces the per-branch required payload at the route layer).
/**
 * L1 score request wire shape, sent to `/api/agentd/v1/l1-score`.
 *
 * Discriminated by `type`: when scoring a command, `command` is
 * required and `output` is rejected; when scoring command output,
 * `output` is required and `command` is rejected. The shared optional
 * fields (`work_dir`, `context_summary`, `model_id`) apply to both.
 */
export type L1ScoreRequest = L1CommandScoreRequest | L1OutputScoreRequest;

// Source: app/api/agentd/v1/l1-score/route.ts:26-32 (commandScoreRequestSchema)
export interface L1CommandScoreRequest {
  type: 'command';
  command: string;
  work_dir?: string;
  context_summary?: string;
  model_id?: string;
}

// Source: app/api/agentd/v1/l1-score/route.ts:34-39 (outputScoreRequestSchema)
export interface L1OutputScoreRequest {
  type: 'output';
  output: string;
  context_summary?: string;
  model_id?: string;
}

// Source: subpackage/agentd/internal/clawless/l1_client.go:233-237
/**
 * One item in a batched L1 score response. `level` uses the batch
 * level enum, which adds `allow` (no risk) and `block` (always
 * reject) beyond the single-command {@link L1Level} set.
 */
export interface L1BatchScoreItem {
  index: number;
  level: L1BatchLevel;
  reason: string;
}

// Source: subpackage/agentd/internal/clawless/l1_client.go:229-231
/**
 * Wrapper around the batch results array returned by
 * `/api/agentd/v1/l1-score-batch`.
 */
export interface L1BatchScoreResult {
  results: L1BatchScoreItem[];
}

// ── L2 ────────────────────────────────────────────────────────────

// Source: lib/security/l2-decision-queue.ts:33-43
export type DecisionStatus =
  | 'pending'
  | 'sent'
  | 'resolved'
  | 'expired'
  | 'timeout'
  | 'denied';

// Source: lib/security/l2-decision-queue.ts:45-52
export type DecisionType = 'l2_auth' | 'question' | 'conflict' | 'branch';

// Source: lib/security/l2-decision-queue.ts:65-74
/**
 * One prompt in a multi-question decision (`type: 'question'`).
 * Used by the daemon's `ask_question` tool to surface structured
 * prompts to the user via the L2 auth flow.
 */
export interface DecisionPrompt {
  question: string;
  header?: string;
  options?: string[];
  multiple?: boolean;
}

// Source: lib/security/l2-decision-queue.ts:75-86
export interface DecisionConflict {
  files?: Array<{
    path: string;
    versions?: string[];
  }>;
}

// Source: lib/security/l2-decision-queue.ts:87-94
export interface DecisionBranch {
  title?: string;
  plan_a?: Record<string, unknown>;
  plan_b?: Record<string, unknown>;
  allow_custom?: boolean;
}

// Source: lib/security/l2-decision-queue.ts:54-105 (Web authoritative)
/**
 * Durable L2 decision row. The Web tier's `l2_decisions` Postgres
 * table is the source of truth; the daemon's per-task `Decision`
 * struct in `clawless/types.go:253-260` is a different (smaller)
 * shape used for task summaries and is intentionally not aliased
 * here.
 *
 * `createdAt` / `timeoutAt` / `resolvedAt` are `Date` on the wire
 * (the Web side serializes via drizzle's timestamptz); when this
 * type round-trips through `JSON.stringify`, callers should pass
 * the row through drizzle or `superjson` to preserve Date identity.
 */
export interface Decision {
  decisionId: string;
  type: DecisionType;
  taskId: string;
  sessionId: string;
  agentId?: string;
  command?: string;
  score?: number;
  reason?: string;
  question?: string;
  options?: string[];
  prompts?: DecisionPrompt[];
  conflict?: DecisionConflict;
  branch?: DecisionBranch;
  status: DecisionStatus;
  nodeId?: string;
  createdAt: Date;
  timeoutAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
  action?: string;
  answers?: string[][];
}

// Source: subpackage/agentd/internal/server/routes.go:522-528
/**
 * L2 confirm action verb. Sent to the daemon's `/api/v1/l2-confirm`
 * endpoint after the user responds to an L2 auth prompt.
 *   - `pass_once` / `reject_once` — single-shot decisions.
 *   - `pass_until` / `reject_until` — persistent until a condition
 *     (carried in `pattern` / `duration`).
 */
export type L2ConfirmAction =
  | 'pass_once'
  | 'pass_until'
  | 'reject_once'
  | 'reject_until';

// Source: subpackage/agentd/internal/server/routes.go:522-528
/**
 * L2 confirm request body. `pattern` is the command pattern the
 * decision applies to (for `pass_until` / `reject_until`); `duration`
 * is `once` / `always` / a date string.
 */
export interface L2ConfirmRequest {
  task_id: string;
  decision_id: string;
  action: L2ConfirmAction;
  pattern?: string;
  duration?: string;
}
