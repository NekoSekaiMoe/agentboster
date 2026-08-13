/**
 * Post-run cleanup workflow — runs memory extraction, skill distillation,
 * and resource cleanup in an INDEPENDENT workflow run, fire-and-forget,
 * after the chat workflow has already closed its UI stream.
 *
 * Why a separate workflow (not inline steps inside chatWorkflow)?
 *   chatWorkflow calls writeStreamClose() immediately after
 *   finalizeRunStep('completed'). The cleanup trio below issues LLM
 *   calls (memory extraction + skill distillation) that can take
 *   seconds-to-minutes; running them as inline steps made the client
 *   block on finish until they completed. Spinning them off into their
 *   own workflow run lets the Queue Service schedule them independently
 *   while the client has already received `finish`.
 *
 * This restores the semantics the codebase had before the
 * fire-and-forget refactor, when cleanup ran in an afterResponse()
 * drain queue ("never blocks the reply"). afterResponse() was removed
 * because no host process reliably drains it under fire-and-forget
 * (POST /api/ai returns 202 immediately); a separate workflow run is
 * the durable replacement.
 *
 * Inputs are the same serializable values chatWorkflow already receives
 * (so they are known workflow-serializable): sessionId, userId, config,
 * user. source.type is passed as a string so the scheduled-session gate
 * can be re-evaluated here without re-serializing the full ChatSource.
 *
 * All three operations are best-effort: each is wrapped so a failure
 * cannot fail the run (and even if the run fails, it has no effect on
 * the already-completed chat run that spawned it).
 *
 * Nesting pattern mirrors `scheduledTaskWorkflow`, which is similarly
 * `start()`-ed from inside another workflow (see
 * lib/workflow/agent/tools/tasks/schedule.ts).
 */
import { extractMemoriesFromSession } from '@/lib/memory/extract';
import { maybeDistillSkillFromSession } from '@/lib/skills/distill';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';
import type { ChatSource } from '@/types/workflow';

const logger = createLogger('workflow.post-run-cleanup');

export interface PostRunCleanupInput {
  sessionId: string;
  /** Owning user; required for memory extraction + skill distillation.
   *  Omitted for scheduled sessions (which only run resource cleanup). */
  userId?: string;
  config: AppConfig;
  user?: { modelPreferences?: { model?: string } | null } | null;
  /** source.type at the time the chat run completed — used to re-evaluate
   *  the scheduled-session gate (scheduled runs skip memory + skills). */
  sourceType: ChatSource['type'];
  /** Workspace scope for memory extraction. Resolved at the host boundary
   *  (chatWorkflow) so the step body doesn't touch the DB directly.
   *  Null/undefined = global layer. */
  workspaceId?: string | null;
  /** The chat run id that just completed. Forwarded by chatWorkflow so
   *  evaluateGoalStep can resume it (via resumeWithMessage) when the
   *  goal evaluator decides to issue a hidden continuation. Null when
   *  the cleanup is spawned outside a chat run (e.g. a manual trigger). */
  runId?: string | null;
}

/**
 * Post-run cleanup workflow. Spawned via `start(postRunCleanupWorkflow,
 * [input])` from chatWorkflow after the UI stream is closed. The parent
 * run does NOT await this — it is fire-and-forget.
 *
 * Step bodies use dynamic `await import(...)` for any DB-touching
 * helper, per the repo rule that files in the workflow tree must not
 * have top-level `node:*` imports (and must not import `next/server`).
 */
export async function postRunCleanupWorkflow(input: PostRunCleanupInput) {
  'use workflow';

  const { sessionId, userId, config, user, sourceType, workspaceId, runId } =
    input;

  // Session-kind gating (OpenClaw hygiene rule): only interactive
  // sessions (web / im / cli) produce durable memory OR staged skills.
  // Scheduled/cron runs are excluded explicitly from BOTH — they can
  // write task artifacts, but nothing they emit is eligible for
  // long-term memory or for review-queue skill drafts.
  if (sourceType !== 'scheduled' && userId) {
    await extractMemoriesStep({
      sessionId,
      userId,
      config,
      user,
      workspaceId,
    });
    await distillSkillStep({
      sessionId,
      userId,
      config,
      user,
    });
  }

  // Session-goal evaluation (interactive only). Runs AFTER memory
  // extraction so the evaluator transcript benefits from the just-written
  // memories, and BEFORE resource cleanup so a continuation decision is
  // recorded even if cleanup later fails. evaluateGoalStep is best-effort
  // (its own try/catch) and never blocks cleanupResourcesStep.
  await evaluateGoalStep({
    sessionId,
    sourceType,
    runId: runId ?? null,
    config,
  });

  // Resource cleanup always runs (regardless of session kind).
  // stopSandbox:false keeps the sandbox warm for the next message in
  // this session (faster startup); it only logs and touches metadata.
  await cleanupResourcesStep({ sessionId, stopSandbox: false });
}

async function extractMemoriesStep(input: {
  sessionId: string;
  userId: string;
  config: AppConfig;
  user?: { modelPreferences?: { model?: string } | null } | null;
  /** Workspace scope, resolved at the host boundary (chatWorkflow reads it
   *  off the session row / lock handle and passes it in). Null/undefined =
   *  global layer. Step bodies must not touch the DB directly. */
  workspaceId?: string | null;
}) {
  'use step';

  try {
    await extractMemoriesFromSession({
      sessionId: input.sessionId,
      userId: input.userId,
      config: input.config,
      user: input.user,
      workspaceId: input.workspaceId ?? null,
    });
  } catch (err) {
    // Best-effort: log and swallow. A failure here must not fail the
    // cleanup run (and even if it did, the parent chat run is already
    // completed and unaffected).
    logger.warn('memory:extract_failed', {
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function distillSkillStep(input: {
  sessionId: string;
  userId: string;
  config: AppConfig;
  user?: { modelPreferences?: { model?: string } | null } | null;
}) {
  'use step';

  try {
    await maybeDistillSkillFromSession({
      sessionId: input.sessionId,
      userId: input.userId,
      config: input.config,
      user: input.user,
    });
  } catch (err) {
    logger.warn('skills:distill_failed', {
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function evaluateGoalStep(input: {
  sessionId: string;
  sourceType: ChatSource['type'];
  runId: string | null;
  /** Host-passed AppConfig — the auto-continuation master switch lives
   *  at autonomy.goal_auto_continue (default false = opt-in loop). */
  config: AppConfig;
}) {
  'use step';

  // Scheduled sessions never self-drive — they are cron-driven, so
  // there is no interactive goal to pursue.
  if (input.sourceType === 'scheduled') {
    return;
  }

  try {
    // All DB / dispatch helpers are dynamically imported: this file is
    // part of the workflow bundle and must not carry top-level node:* /
    // third-party deps (see AGENTS.md "Top-level node:* imports break
    // the workflow bundle").
    const {
      getSessionGoalState,
      incrementGoalCounters,
      reserveGoalContinuation,
    } = await import('@/lib/core/db/chat');
    const { getVisibleSessionMessages } = await import('@/lib/core/db/chat');
    const {
      evaluateSessionGoal,
      shouldContinueWithHiddenRun,
      MAX_EVALUATION_MESSAGES,
      MAX_EVALUATION_CHARS,
    } = await import('@/lib/workflow/agent/session-goal');

    const state = await getSessionGoalState(input.sessionId);
    // No goal → nothing to evaluate. The whole loop is opt-in via a
    // non-null goal_text.
    if (!state.goalText) {
      return;
    }

    // Build the evaluator transcript from the most recent visible
    // messages, trimmed to the evaluator's window. Only user / assistant
    // turns feed the classifier (session-goal.ts EvaluateSessionGoalInput).
    const allMessages = await getVisibleSessionMessages(input.sessionId);
    const transcript = buildGoalTranscript(
      allMessages,
      MAX_EVALUATION_MESSAGES,
      MAX_EVALUATION_CHARS,
    );

    const evaluation = await evaluateSessionGoal({
      goal: state.goalText,
      transcript,
    });

    // The no-progress breaker fires after MAX_IDENTICAL_NON_PROGRESS (2)
    // consecutive evaluations with the SAME reasoning. Detect "same as
    // last time" by comparing the recorded lastEvalReason to this one;
    // a change RESETS the streak to 0 (resetNonProgress — an absolute
    // write, since a 0 delta is a truthy-skip in incrementGoalCounters).
    const identicalToLast =
      state.lastEvalReason !== null &&
      state.lastEvalReason === evaluation.reasoning;

    const decision = shouldContinueWithHiddenRun({
      evaluation,
      hiddenContinuationCount: state.hiddenCount,
      consecutiveIdenticalNonProgress: state.consecutiveNonProgress,
      // The run has already finalized by the time post-run cleanup
      // spawns, so its final assistant turn IS durably checkpointed
      // (finalizeRunStep persisted it). post-run runs in a separate
      // workflow run with no concurrency on this session's thread, so
      // the thread cannot have changed under us.
      latestTurnCheckpointed: true,
      threadChangedDuringEvaluation: false,
      // Master switch from AppConfig (autonomy.goal_auto_continue).
      // Default false: the self-driving loop is opt-in, matching the
      // contract documented in session-goal.ts.
      autoContinueEnabled: input.config.autonomy?.goal_auto_continue === true,
    });

    if (decision.continue && input.runId) {
      // Reserve the continuation slot atomically: bump the counters AND
      // verify the goal is still set in a single UPDATE. If the user
      // `/goal clear`-ed (or replaced the goal) while the evaluator was
      // running, the optimistic-lock predicate (goal_text IS NOT NULL)
      // fails, reserveGoalContinuation returns null, and we abandon the
      // resume — the old code had a window where it resumed a just-cleared
      // goal. The counter reservation commits here; if the resume below
      // then fails, we compensate by reversing the deltas.
      const reservation = await reserveGoalContinuation(input.sessionId, {
        hiddenDelta: 1,
        ...(identicalToLast
          ? { nonProgressDelta: 1 }
          : { resetNonProgress: true }),
        lastEvalReason: evaluation.reasoning,
      });
      if (!reservation) {
        // Goal was cleared/replaced mid-evaluation. Don't resume, don't
        // touch counters (the clearing write owns them now).
        logger.info('session-goal:reservation_aborted_goal_changed', {
          sessionId: input.sessionId,
          runId: input.runId,
        });
        return;
      }

      // Issue the hidden continuation. The parent chat run must still be
      // resumable for this to land; if it has already been GC'd or
      // closed, resumeWithMessage throws and we reverse the counter
      // reservation below so we don't burn a slot on a resume that
      // didn't land.
      try {
        const { resumeWithMessage } = await import(
          '@/lib/workflow/agent/dispatch'
        );
        await resumeWithMessage(input.runId, {
          type: 'control',
          command: 'goal-continue',
          reason: 'goal_not_met_yet',
        });
      } catch (resumeError) {
        logger.warn('session-goal:resume_failed', {
          sessionId: input.sessionId,
          runId: input.runId,
          error:
            resumeError instanceof Error
              ? resumeError.message
              : String(resumeError),
        });
        // Compensating rollback: undo the counter reservation so a failed
        // resume doesn't consume a hidden-continuation slot. We still keep
        // the lastEvalReason write (it's a useful UI signal and doesn't
        // affect the breaker math). Reverse the same deltas we reserved;
        // for resetNonProgress we can't un-reset, but a failed resume is
        // terminal for this cycle anyway and the next successful resume
        // will re-derive the streak.
        await incrementGoalCounters(input.sessionId, {
          hiddenDelta: -1,
          ...(identicalToLast ? { nonProgressDelta: -1 } : {}),
          lastEvalReason: evaluation.reasoning,
        });
        return;
      }

      logger.info('session-goal:continued', {
        sessionId: input.sessionId,
        runId: input.runId,
        reasoning: evaluation.reasoning,
        hiddenCount: state.hiddenCount + 1,
      });
      return;
    }

    // Continuation denied (or no runId to resume): record the latest
    // evaluation reason + advance the non-progress streak so a future
    // interactive turn can see how close the breaker was. A changed
    // reason RESETS the streak. Do NOT bump hiddenContinuationCount —
    // no continuation was issued.
    await incrementGoalCounters(input.sessionId, {
      ...(identicalToLast
        ? { nonProgressDelta: 1 }
        : { resetNonProgress: true }),
      lastEvalReason: evaluation.reasoning,
    });
    logger.info('session-goal:stopped', {
      sessionId: input.sessionId,
      runId: input.runId,
      blocker: evaluation.blocker,
      reasoning: evaluation.reasoning,
      denialReason: decision.denialReason,
    });
  } catch (err) {
    // Best-effort: a failure here must not fail the cleanup run (and
    // even if it did, the parent chat run is already completed and
    // unaffected).
    logger.warn('session-goal:eval_failed', {
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Build the `{ role, content }` transcript the goal evaluator consumes,
 * from the session's visible messages. Takes the LAST `maxMessages` rows
 * (most recent state matters most), keeps only user / assistant turns,
 * and trims the total character budget FROM THE NEWEST ENTRY BACKWARDS —
 * when the budget trips, the oldest entries are dropped and the most
 * recent assistant turn (what the classifier most needs to see) always
 * survives. Tool / summary / system rows are dropped — the classifier
 * reasons over the user/assistant dialogue, not raw tool I/O.
 */
function buildGoalTranscript(
  rows: ReadonlyArray<{
    role: string;
    payload: Record<string, unknown> | null;
  }>,
  maxMessages: number,
  maxChars: number,
): { role: 'user' | 'assistant'; content: string }[] {
  // Newest-first accumulation: reverse so the budget is spent on the
  // most recent turns and an overflow truncates the OLDEST entry, not
  // the tail. The result is reversed back to chronological order at
  // the end.
  const recent = rows.slice(-maxMessages).reverse();
  const transcript: { role: 'user' | 'assistant'; content: string }[] = [];
  let totalChars = 0;

  for (const row of recent) {
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    const text =
      (row.payload && (row.payload.text as string | undefined)) ?? '';
    const content = text.trim();
    if (!content) continue;

    totalChars += content.length;
    if (totalChars > maxChars) {
      // Truncate the entry that crosses the budget (the oldest one that
      // still partially fits) rather than dropping the newest turns.
      const remaining = Math.max(0, maxChars - (totalChars - content.length));
      if (remaining > 0) {
        transcript.push({
          role: row.role,
          content: content.slice(0, remaining),
        });
      }
      break;
    }
    transcript.push({ role: row.role, content });
  }

  // Restore chronological order (oldest → newest) for the evaluator.
  return transcript.reverse();
}

async function cleanupResourcesStep(input: {
  sessionId: string;
  stopSandbox: boolean;
}) {
  'use step';

  try {
    const { cleanupWorkflowResources } = await import('./cleanup');
    await cleanupWorkflowResources({
      sessionId: input.sessionId,
      stopSandbox: input.stopSandbox,
    });
  } catch (err) {
    logger.warn('cleanup:failed', {
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
