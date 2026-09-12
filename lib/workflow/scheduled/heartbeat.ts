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

async function postHeartbeatTrigger(sessionId: string) {
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
    },
  );
  if (!response.ok) {
    throw new Error(
      `Heartbeat callback failed with status ${response.status}.`,
    );
  }
  return response._data as unknown;
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

    try {
      await postHeartbeatTrigger(sessionId);
    } catch (error) {
      // The endpoint records failures on the row (failureCount /
      // auto-disable). A transient HTTP error must not kill the loop —
      // the next slot retries.
      logger.warn('wake_workflow:trigger_failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
