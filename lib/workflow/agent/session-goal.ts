/**
 * Session Goal — a thread-scoped completion condition for a self-driving
 * agent loop with brakes. Ported conceptually from deer-flow's goal_state.py
 * + runtime/goal.py.
 *
 * DESIGN (all 4 conditions must hold for a hidden auto-continuation to fire
 * after a run completes — same gate as deer-flow):
 *
 *   1. The latest assistant turn is durably checkpointed (don't continue
 *      from an unsaved state).
 *   2. The goal evaluator returns GoalBlocker.goal_not_met_yet (typed
 *      blocker — see below).
 *   3. The thread didn't change during evaluation (no /new, no
 *      /switch landed between the run completing and the evaluator
 *      finishing).
 *   4. The no-progress breaker hasn't fired (≤ MAX_HIDDEN_CONTINUATIONS
 *      total per goal, and ≤ MAX_IDENTICAL_NON_PROGRESS consecutive
 *      identical non-progress evaluations).
 *
 * The typed GoalBlocker enum is the key correctness property: only
 * `goal_not_met_yet` triggers a continuation. `needs_user_input`,
 * `run_failed`, `external_wait` etc. all STOP the loop, so the agent
 * doesn't burn tokens waiting on something that won't resolve on its own.
 *
 * PHASE-1 SCOPE: this module ships the data model + evaluator + the typed
 * blocker. The auto-continuation INTEGRATION (the fire path from
 * post-run-cleanup.ts → evaluateSessionGoal → resumeWithMessage) is wired
 * but gated behind SESSION_GOAL_AUTO_CONTINUE (default false) so the loop
 * is opt-in. The /goal command (set/clear/show) sets the field on the
 * session; the loop only acts when the flag is on.
 */
import { getConfig } from '@/lib/core/kv/config';
import { generateObject, NoObjectGeneratedError } from 'ai';
import { z } from 'zod';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('agent.session-goal');

/**
 * Maximum hidden continuations per goal before the breaker trips. Mirrors
 * deer-flow's MAX_HIDDEN_CONTINUATIONS = 8.
 */
export const MAX_HIDDEN_CONTINUATIONS = 8;

/**
 * Maximum consecutive identical non-progress evaluations before the breaker
 * trips. Mirrors deer-flow's MAX_IDENTICAL_NON_PROGRESS = 2. The point: if
 * the evaluator says "goal_not_met_yet" twice in a row with the same
 * reasoning, the agent is stuck — stop.
 */
export const MAX_IDENTICAL_NON_PROGRESS = 2;

/**
 * Typed completion-blocker. The evaluator returns EXACTLY ONE; only
 * `goal_not_met_yet` permits a hidden continuation. Every other value
 * stops the loop for a concrete reason the UI can surface.
 *
 * Mirrors deer-flow's GoalBlocker union. The enum (not a string union) is
 * deliberate so a future caller can't typo a new value without updating
 * the switch sites that decide continuation eligibility.
 */
export const GoalBlocker = {
  /** Goal achieved — stop, we're done. */
  none: 'none',
  /** The assistant's latest turn cites missing evidence/files/inputs that
   *  the user must provide; continuing won't help. */
  missing_evidence: 'missing_evidence',
  /** The assistant is explicitly asking the user a question. */
  needs_user_input: 'needs_user_input',
  /** The last run errored. Continuing would just re-fail. */
  run_failed: 'run_failed',
  /** The assistant is waiting on an async/external event (scheduled task,
   *  webhook, long-running tool) that isn't done yet. */
  external_wait: 'external_wait',
  /** Goal not yet met AND none of the above blockers apply — the ONLY
   *  value that permits a hidden continuation. */
  goal_not_met_yet: 'goal_not_met_yet',
} as const;
export type GoalBlocker = (typeof GoalBlocker)[keyof typeof GoalBlocker];

/**
 * Whether a blocker permits a hidden auto-continuation. Only
 * `goal_not_met_yet` does. Centralized so the continuation-decision site
 * can't accidentally widen the gate.
 */
export function blockerPermitsContinuation(b: GoalBlocker): boolean {
  return b === GoalBlocker.goal_not_met_yet;
}

const goalEvaluationSchema = z.object({
  blocker: z.enum([
    GoalBlocker.none,
    GoalBlocker.missing_evidence,
    GoalBlocker.needs_user_input,
    GoalBlocker.run_failed,
    GoalBlocker.external_wait,
    GoalBlocker.goal_not_met_yet,
  ]),
  /** ≤1 sentence reasoning for the blocker choice. Surfaces in the UI when
   *  the loop stops so the user knows why the agent didn't continue. */
  reasoning: z.string().max(280),
});

export interface GoalEvaluation {
  blocker: GoalBlocker;
  reasoning: string;
}

export interface EvaluateSessionGoalInput {
  /** The goal text (≤ MAX_GOAL_OBJECTIVE_CHARS). */
  goal: string;
  /** The recent conversation transcript, already trimmed to the evaluator's
   *  window (caller enforces MAX_EVALUATION_MESSAGES / MAX_EVALUATION_CHARS). */
  transcript: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  /** Optional override of the model id (defaults to config.models.model). */
  modelId?: string;
}

export const MAX_GOAL_OBJECTIVE_CHARS = 4000;
export const MAX_EVALUATION_MESSAGES = 30;
export const MAX_EVALUATION_CHARS = 12000;

/**
 * Evaluate a session goal against the visible transcript using a
 * NON-THINKING evaluator model (matches deer-flow — thinking is wasted on
 * a classifier and burns latency). Returns the typed blocker + ≤1 sentence
 * reasoning.
 *
 * Fail-closed: if the model returns unparseable JSON or throws, the
 * evaluation returns `goal_not_met_yet` with reasoning "evaluation failed"
 * — this is the conservative choice for the case where auto-continue is
 * OFF (the value is recorded but never acted on). When auto-continue is
 * ON, the caller should treat a parse failure as `needs_user_input`
 * instead (don't loop on a broken evaluator). See shouldContinue.
 */
export async function evaluateSessionGoal(
  input: EvaluateSessionGoalInput,
): Promise<GoalEvaluation> {
  if (input.goal.length > MAX_GOAL_OBJECTIVE_CHARS) {
    return {
      blocker: GoalBlocker.none,
      reasoning:
        'Goal objective exceeds the character limit; refusing to evaluate.',
    };
  }
  if (input.transcript.length === 0) {
    return {
      blocker: GoalBlocker.needs_user_input,
      reasoning: 'No conversation to evaluate yet.',
    };
  }

  const config = await getConfig();
  const modelId = input.modelId ?? config.models?.model;
  if (!modelId) {
    return {
      blocker: GoalBlocker.needs_user_input,
      reasoning: 'No evaluator model configured.',
    };
  }

  const { resolveLanguageModel } = await import('@/lib/ai');
  const model = resolveLanguageModel(modelId, config);

  const transcriptText = input.transcript
    .map((t) => `${t.role}: ${t.content}`)
    .join('\n\n')
    .slice(0, MAX_EVALUATION_CHARS);

  try {
    const { object } = await generateObject({
      model,
      schema: goalEvaluationSchema,
      schemaName: 'GoalEvaluation',
      schemaDescription:
        'Classify whether the session goal is met, blocked, or still pending. Pick exactly one blocker.',
      system: `You are a goal-evaluation classifier for an AI agent session. Read the conversation transcript and the session goal, then classify the state.

Return EXACTLY ONE blocker:
- "none": the goal is fully achieved
- "missing_evidence": the assistant needs files/inputs/evidence the user must provide
- "needs_user_input": the assistant asked the user a direct question
- "run_failed": the last run errored and continuing would re-fail
- "external_wait": waiting on an async/external event (scheduled task, webhook, long-running tool)
- "goal_not_met_yet": the goal is not yet achieved AND none of the above apply (the agent could plausibly make more progress on its own)

Be conservative: when in doubt between "goal_not_met_yet" and a user-blocking value, prefer the user-blocking one. Do NOT classify as "goal_not_met_yet" if the last assistant turn ends with a question or a request for input.

The reasoning is ≤1 sentence and will be shown to the user if the loop stops.`,
      prompt: `# Session Goal\n${input.goal}\n\n# Conversation Transcript\n${transcriptText}\n\n# Task\nClassify the current state.`,
    });
    return { blocker: object.blocker, reasoning: object.reasoning };
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      logger.warn('goal_evaluator:no_object', {
        message: error.message,
      });
    } else {
      logger.warn('goal_evaluator:failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Fail-closed for the classifier itself. The continuation site treats
    // a parse failure as STOP (needs_user_input) so a broken evaluator
    // can't drive an infinite loop.
    return {
      blocker: GoalBlocker.needs_user_input,
      reasoning: 'Goal evaluation failed; not continuing automatically.',
    };
  }
}

/**
 * The continuation decision. Centralizes ALL FOUR preconditions from the
 * module docstring so the call site is one branch. Returns the reason
 * when continuation is denied (for logging/UI).
 */
export interface ContinuationDecision {
  continue: boolean;
  /** Why continuation was denied. Null when continue=true. */
  denialReason: string | null;
}

export function shouldContinueWithHiddenRun(input: {
  evaluation: GoalEvaluation;
  /** Number of hidden continuations already issued for this goal. */
  hiddenContinuationCount: number;
  /** Consecutive identical "goal_not_met_yet" evaluations before this one.
   *  Reset to 0 when the blocker or reasoning changes. */
  consecutiveIdenticalNonProgress: number;
  /** Whether the latest assistant turn is durably checkpointed. False
   *  blocks continuation (don't build on an unsaved state). */
  latestTurnCheckpointed: boolean;
  /** Whether the thread changed during evaluation (e.g. user typed /new).
   *  True blocks continuation. */
  threadChangedDuringEvaluation: boolean;
  /** Master switch. False = the loop is off; never continue. */
  autoContinueEnabled: boolean;
}): ContinuationDecision {
  if (!input.autoContinueEnabled) {
    return { continue: false, denialReason: 'auto-continue disabled' };
  }
  if (!input.latestTurnCheckpointed) {
    return {
      continue: false,
      denialReason: 'latest assistant turn not yet checkpointed',
    };
  }
  if (input.threadChangedDuringEvaluation) {
    return {
      continue: false,
      denialReason: 'thread changed during evaluation',
    };
  }
  if (!blockerPermitsContinuation(input.evaluation.blocker)) {
    return {
      continue: false,
      denialReason: `blocker=${input.evaluation.blocker} does not permit continuation`,
    };
  }
  if (input.hiddenContinuationCount >= MAX_HIDDEN_CONTINUATIONS) {
    return {
      continue: false,
      denialReason: `reached max hidden continuations (${MAX_HIDDEN_CONTINUATIONS})`,
    };
  }
  if (input.consecutiveIdenticalNonProgress >= MAX_IDENTICAL_NON_PROGRESS) {
    return {
      continue: false,
      denialReason: `no-progress breaker tripped (${MAX_IDENTICAL_NON_PROGRESS} identical non-progress evaluations)`,
    };
  }
  return { continue: true, denialReason: null };
}
