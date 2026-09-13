/**
 * Session heartbeat wake workflow (workflow-only module).
 *
 * The agentboster port of arkloop's LLM Heartbeat scheduler
 * (ref/arkloop llm_heartbeat_scheduler.go): a per-session sleeping loop
 * that wakes on `session_heartbeats.next_run_at` and posts to the internal
 * bot trigger endpoint. The endpoint (host code, see heartbeat-dispatch.ts)
 * CAS-claims the slot and dispatches a chat run with `heartbeat: true`.
 *
 * SPLIT NOTE — this file is deliberately workflow-only (mirrors
 * lib/workflow/scheduled/index.ts vs dispatch.ts): once a module containing
 * a `'use workflow'` export enters the DevKit bundle, every import in the
 * module — dynamic ones included — is walked by the node-module checker.
 * Host-side dispatch (db/users, config, startWorkflow) lives in
 * heartbeat-dispatch.ts so its dependency chain (bcryptjs via
 * db/users → auth/password) never touches this module.
 *
 * Design + verified mechanics:
 * .agents/notes/implemented/feature/2026-09-13-session-heartbeat.md
 */
import { createLogger } from '@/lib/utils/logger';
import { sleep } from 'workflow';

const logger = createLogger('workflow.heartbeat');

async function readHeartbeatRow(sessionId: string) {
  'use step';

  const { getSessionHeartbeat } = await import('@/lib/core/db/heartbeat');
  return getSessionHeartbeat(sessionId);
}

/** Outcome of one trigger POST: whether it got 2xx, the HTTP status when a
 *  response arrived (null = the request never reached the endpoint: URL /
 *  auth-secret construction or network failure), and the error message for
 *  diagnostics. Returned instead of thrown so the counting decision below
 *  can see WHO already recorded the failure. */
export interface TriggerOutcome {
  ok: boolean;
  status: number | null;
  error?: string;
}

export async function postHeartbeatTrigger(
  sessionId: string,
): Promise<TriggerOutcome> {
  'use step';

  const { assertBotAuthSecret, getAppBaseUrl } = await import(
    '@/lib/bot/webhook'
  );
  const { ofetch } = await import('ofetch');
  const response = await ofetch.raw(
    `${getAppBaseUrl()}/api/bot/${assertBotAuthSecret()}/heartbeat`,
    {
      method: 'POST',
      body: { sessionId },
      // Resolve (instead of throw) on non-2xx so the status survives to
      // the caller — who counts the failure depends on it.
      ignoreResponseError: true,
    },
  );
  return { ok: response.ok, status: response.status };
}

/**
 * Whether the wake loop itself must record a failure for a trigger outcome.
 *
 * Counting rules: the endpoint records failures itself in
 * deliverSessionHeartbeat (no-thread / dispatch failure → markFailed → the
 * route answers 500), so a 500 response has ALREADY been counted — recording
 * it here too would double-increment failureCount. Everything else that is
 * not 2xx is invisible to the endpoint's accounting and must be recorded
 * here:
 * - status === null: the request never arrived (missing auth secret, bad
 *   base URL, network error) — nothing ran on the other side;
 * - 4xx the endpoint emitted WITHOUT counting (403 bad secret, 400 bad
 *   body) and proxy 5xx that never reached the app.
 */
export function shouldRecordTriggerFailure(outcome: {
  ok: boolean;
  status: number | null;
}): boolean {
  if (outcome.ok) return false;
  return outcome.status === null || outcome.status !== 500;
}

/** Record a trigger failure on the row (SQL-side increment + auto-disable
 *  at MAX_HEARTBEAT_FAILURES — both live in recordHeartbeatResult). */
async function recordTriggerFailureStep(sessionId: string): Promise<void> {
  'use step';

  const { recordHeartbeatResult } = await import('@/lib/core/db/heartbeat');
  await recordHeartbeatResult({
    sessionId,
    reply: false,
    chatRunId: null,
    failed: true,
  });
}

/**
 * Per-session wake loop. Sleeps until next_run_at, posts the trigger
 * (the endpoint's CAS claim dedupes concurrent loops and stale wakes),
 * re-reads config, and repeats. Exits when the heartbeat is disabled or
 * the row is gone (session deleted — cascade).
 */
export async function sessionHeartbeatWorkflow(sessionId: string) {
  'use workflow';

  for (;;) {
    const row = await readHeartbeatRow(sessionId);
    if (!row?.enabled || !row.nextRunAt) {
      return { sessionId, status: 'stopped' as const };
    }

    await sleep(row.nextRunAt);

    // Re-read after waking: the config may have changed while we slept
    // (interval edited, disabled, re-enabled with a fresh slot).
    const after = await readHeartbeatRow(sessionId);
    if (!after?.enabled) {
      return { sessionId, status: 'stopped' as const };
    }
    if (after.nextRunAt && after.nextRunAt.getTime() > Date.now()) {
      // Not actually due (interval changed mid-sleep) — loop back to
      // sleep until the new slot.
      continue;
    }

    // Fire the trigger. Failures are classified, not just logged: the ones
    // the endpoint already counted (its 500s) must not be re-counted, the
    // ones it never saw (no response / 4xx / proxy 5xx) must be recorded
    // here or a permanently broken trigger path would spin forever without
    // ever tripping auto-disable. A failing record step must not kill the
    // loop either — the next slot retries the whole cycle.
    let outcome: TriggerOutcome;
    try {
      outcome = await postHeartbeatTrigger(sessionId);
    } catch (error) {
      // The trigger step itself blew up (import/machinery) — no HTTP
      // outcome exists; treat it as a never-reached-endpoint failure.
      outcome = {
        ok: false,
        status: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!outcome.ok) {
      logger.warn('wake_workflow:trigger_failed', {
        sessionId,
        status: outcome.status,
        error: outcome.error,
      });
      if (shouldRecordTriggerFailure(outcome)) {
        try {
          await recordTriggerFailureStep(sessionId);
        } catch (recordError) {
          logger.warn('wake_workflow:failure_record_failed', {
            sessionId,
            error:
              recordError instanceof Error
                ? recordError.message
                : String(recordError),
          });
        }
      }
    }
  }
}
