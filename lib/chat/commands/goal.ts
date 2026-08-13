import {
  clearSessionGoal,
  getSessionGoalState,
  setSessionGoal,
} from '@/lib/core/db/chat';
import { MAX_GOAL_OBJECTIVE_CHARS } from '@/lib/workflow/agent/session-goal';

/**
 * `/goal` — manage the session-scoped self-driving objective.
 *
 * Subcommands:
 *   /goal set <text>   set a new goal (resets the continuation counters;
 *                      rejects while a run is active so the loop sees a
 *                      clean state)
 *   /goal clear        drop the current goal and zero the counters
 *   /goal              show the current goal + counter state
 *
 * The counters surfaced here (hiddenCount / consecutiveNonProgress) are
 * the same ones the post-run evaluator reads in
 * lib/workflow/agent/post-run-cleanup.ts; surfacing them lets the user
 * see how close the breaker is to tripping.
 */
export async function executeGoalCommand(args: {
  sessionId: string;
  args: string;
  /** Active workflow run id, or null when the session is idle. set/clear
   *  are rejected while a run is live so the counters never change under
   *  a running evaluation. */
  activeRunId: string | null;
}): Promise<string> {
  const { sessionId, activeRunId } = args;
  const trimmed = args.args.trim();

  // No subcommand → show current state.
  if (!trimmed) {
    const state = await getSessionGoalState(sessionId);
    if (!state.goalText) {
      return 'No goal set. Use `/goal set <text>` to define one.';
    }
    return [
      `**Goal:** ${state.goalText}`,
      `Hidden continuations: ${state.hiddenCount} / 8`,
      `Consecutive identical non-progress: ${state.consecutiveNonProgress} / 2`,
      state.lastEvalReason ? `Last evaluation: ${state.lastEvalReason}` : '',
    ]
      .filter((line) => line.length > 0)
      .join('\n');
  }

  const [sub, ...rest] = trimmed.split(/\s+/);
  const restText = rest.join(' ').trim();

  if (sub === 'set') {
    if (!restText) {
      return 'Usage: /goal set <text>';
    }
    if (activeRunId) {
      return 'Cannot set a goal while a run is active. Wait for it to finish or /stop it first.';
    }
    if (restText.length > MAX_GOAL_OBJECTIVE_CHARS) {
      return `Goal is too long (${restText.length} > ${MAX_GOAL_OBJECTIVE_CHARS} chars).`;
    }
    await setSessionGoal(sessionId, restText);
    return `Goal set. The agent will self-drive toward it until it's met or the breaker trips.\n\n${restText}`;
  }

  if (sub === 'clear') {
    if (activeRunId) {
      return 'Cannot clear the goal while a run is active. Wait for it to finish or /stop it first.';
    }
    await clearSessionGoal(sessionId);
    return 'Goal cleared. The agent will no longer self-drive.';
  }

  return 'Usage: /goal set <text> | /goal clear | /goal';
}
