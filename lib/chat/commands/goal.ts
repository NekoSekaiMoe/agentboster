import { t } from '@/lib/i18n/server';
import type { Locale } from '@/lib/i18n';
import {
  clearSessionGoal,
  getSessionGoalState,
  setSessionGoal,
} from '@/lib/core/db/chat';
import {
  MAX_GOAL_OBJECTIVE_CHARS,
  MAX_HIDDEN_CONTINUATIONS,
  MAX_IDENTICAL_NON_PROGRESS,
} from '@/lib/workflow/agent/session-goal';

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
 *
 * All user-facing strings run through the i18n `t(locale, ...)` helper;
 * the caller (lib/chat/index.ts) resolves the locale from session/source
 * metadata and passes it in, mirroring executeVersionCommand /
 * executeStartCommand.
 */
export async function executeGoalCommand(args: {
  sessionId: string;
  args: string;
  locale: Locale;
  /** Active workflow run id, or null when the session is idle. set/clear
   *  are rejected while a run is live so the counters never change under
   *  a running evaluation. */
  activeRunId: string | null;
}): Promise<string> {
  const { sessionId, activeRunId, locale } = args;
  const trimmed = args.args.trim();

  // No subcommand → show current state.
  if (!trimmed) {
    const state = await getSessionGoalState(sessionId);
    if (!state.goalText) {
      return t(locale, 'cmd.goal.noGoal');
    }
    return [
      t(locale, 'cmd.goal.statusGoal', { goal: state.goalText }),
      t(locale, 'cmd.goal.statusHidden', {
        count: state.hiddenCount,
        max: MAX_HIDDEN_CONTINUATIONS,
      }),
      t(locale, 'cmd.goal.statusNonProgress', {
        count: state.consecutiveNonProgress,
        max: MAX_IDENTICAL_NON_PROGRESS,
      }),
      state.lastEvalReason
        ? t(locale, 'cmd.goal.statusEval', { reason: state.lastEvalReason })
        : '',
    ]
      .filter((line) => line.length > 0)
      .join('\n');
  }

  const [sub, ...rest] = trimmed.split(/\s+/);
  const restText = rest.join(' ').trim();

  if (sub === 'set') {
    if (!restText) {
      return t(locale, 'cmd.goal.usageSet');
    }
    if (activeRunId) {
      return t(locale, 'cmd.goal.setRunActive');
    }
    if (restText.length > MAX_GOAL_OBJECTIVE_CHARS) {
      return t(locale, 'cmd.goal.tooLong', {
        length: restText.length,
        max: MAX_GOAL_OBJECTIVE_CHARS,
      });
    }
    await setSessionGoal(sessionId, restText);
    return t(locale, 'cmd.goal.setOk', { text: restText });
  }

  if (sub === 'clear') {
    if (activeRunId) {
      return t(locale, 'cmd.goal.clearRunActive');
    }
    await clearSessionGoal(sessionId);
    return t(locale, 'cmd.goal.clearOk');
  }

  return t(locale, 'cmd.goal.usage');
}
