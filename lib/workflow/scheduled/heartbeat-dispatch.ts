/**
 * Session heartbeat dispatcher (host-side module, mirrors
 * lib/workflow/scheduled/dispatch.ts's role for scheduledTaskWorkflow).
 *
 * Called by the bot trigger endpoint; never part of the DevKit workflow
 * bundle, so its dependency chain (db/users → auth/password → bcryptjs,
 * config, startWorkflow) is free to be host-only.
 */
import { createLogger } from '@/lib/utils/logger';
import { getRun, start } from 'workflow/api';
import type { ChatSource, IMChatSource } from '@/types/workflow';

const logger = createLogger('workflow.heartbeat.dispatch');

/**
 * The synthetic instruction appended as the LAST user message of the run.
 * Injected by the dispatcher into `initialMessages` and NEVER persisted —
 * arkloop marks the synthetic turn with a nil thread-message id for the
 * same reason: cycles must not pollute the transcript.
 */
const HEARTBEAT_WAKEUP_PROMPT = [
  '[heartbeat] Scheduled wake-up for this thread.',
  'Review the recent conversation above (read-only tools are available if you need more context).',
  'FIRST call heartbeat_decision:',
  '- reply=false when there is nothing genuinely worth saying right now — the default and always acceptable;',
  '- reply=true only for a finished result the user is waiting on, an urgent issue, or a time-sensitive answer.',
  'If you decide to speak, compose exactly one short message for the thread; do not repeat this instruction or mention the heartbeat mechanics.',
].join(' ');

/**
 * Start (or restart) the wake loop for a session. Fire-and-forget.
 *
 * Exactly-one-run coordination (repeated/concurrent PUTs must not stack
 * sleeping loops):
 * 1. A recorded run id that is still live (pending/running) is reused —
 *    no new run is started.
 * 2. Otherwise a replacement run is started and CAS-claimed on the row
 *    (`claimHeartbeatWorkflowRunId`): if a concurrent ensure replaced the
 *    column first, our run lost the race and is cancelled, keeping exactly
 *    one active loop. Terminal runs (completed/failed/cancelled) and stale
 *    run ids (run evicted — getRun throws) are transparently replaced.
 */
export async function ensureHeartbeatWorkflow(sessionId: string) {
  try {
    const { sessionHeartbeatWorkflow } = await import(
      '@/lib/workflow/scheduled/heartbeat'
    );
    const { claimHeartbeatWorkflowRunId, getSessionHeartbeat } = await import(
      '@/lib/core/db/heartbeat'
    );

    const row = await getSessionHeartbeat(sessionId);
    const existingRunId = row?.heartbeatWorkflowRunId ?? null;
    if (existingRunId) {
      try {
        const status = await getRun(existingRunId).status;
        if (status === 'pending' || status === 'running') {
          logger.info('wake_workflow:reused', {
            sessionId,
            runId: existingRunId,
          });
          return existingRunId;
        }
      } catch {
        // Unknown/evicted run id — fall through and start a replacement.
      }
    }

    const run = await start(sessionHeartbeatWorkflow, [sessionId]);
    const claimedRunId = await claimHeartbeatWorkflowRunId({
      sessionId,
      expectedRunId: existingRunId,
      newRunId: run.runId,
    });
    if (claimedRunId !== run.runId) {
      // Lost the race: a concurrent ensure already parked ITS run on the
      // row. Cancel ours so only the winner keeps looping. (A null claim
      // also covers the row being deleted mid-flight — the cancelled run
      // would have exited at its next config read anyway.)
      try {
        await run.cancel();
      } catch (cancelError) {
        // Best-effort: a failed cancel leaves a duplicate loop that the
        // endpoint's CAS claim already dedupes on every wake.
        logger.warn('wake_workflow:cancel_failed', {
          sessionId,
          runId: run.runId,
          error:
            cancelError instanceof Error
              ? cancelError.message
              : String(cancelError),
        });
      }
      logger.info('wake_workflow:superseded', {
        sessionId,
        runId: run.runId,
        winnerRunId: claimedRunId,
      });
      return claimedRunId;
    }
    logger.info('wake_workflow:started', { sessionId, runId: run.runId });
    return run.runId;
  } catch (error) {
    logger.warn('wake_workflow:start_failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Dispatch one due heartbeat wake-up. Called by the bot trigger endpoint;
 * claimDueHeartbeat is the idempotency gate — two concurrent ticks can
 * never both dispatch the same slot.
 */
export async function deliverSessionHeartbeat(input: {
  sessionId: string;
}): Promise<{
  status: 'dispatched' | 'not-due' | 'session-not-found' | 'no-thread';
  runId?: string;
}> {
  const { getSession } = await import('@/lib/core/db/chat');
  const { claimDueHeartbeat, MAX_HEARTBEAT_FAILURES, recordHeartbeatResult } =
    await import('@/lib/core/db/heartbeat');

  const session = await getSession(input.sessionId);
  if (!session) {
    return { status: 'session-not-found' };
  }

  // Claim the due slot first — this is the idempotency gate.
  const claimed = await claimDueHeartbeat({ sessionId: input.sessionId });
  if (!claimed) {
    return { status: 'not-due' };
  }

  const markFailed = async (reason: string) => {
    // recordHeartbeatResult auto-disables at MAX_HEARTBEAT_FAILURES (the
    // disable check is centralized there — the run-side delivery gate and
    // the wake-loop trigger failures flow through the same function);
    // here we only add the reason to the log.
    const row = await recordHeartbeatResult({
      sessionId: input.sessionId,
      reply: false,
      chatRunId: null,
      failed: true,
    });
    if ((row?.failureCount ?? 0) >= MAX_HEARTBEAT_FAILURES) {
      logger.warn('heartbeat:auto_disabled', {
        sessionId: input.sessionId,
        failureCount: row?.failureCount,
        reason,
      });
    }
  };

  const threadId = session.externalThreadId;
  if (!threadId) {
    await markFailed('session has no external thread to speak into');
    return { status: 'no-thread' };
  }

  // Reconstruct the IM source from the session so the run (and delivery)
  // target the thread this session was born from.
  const source: IMChatSource = {
    type: 'im',
    adapter: session.channel as IMChatSource['adapter'],
    origin: session.channelOrigin ?? '',
    threadId,
    userId: session.userId ?? null,
  };

  try {
    const { getConfig } = await import('@/lib/core/kv/config');
    const { getUserById } = await import('@/lib/core/db/users');
    const config = await getConfig();
    const user = session.userId ? await getUserById(session.userId) : null;

    const { buildInitialContextMessages } = await import(
      '@/lib/workflow/agent/context'
    );
    const history = await buildInitialContextMessages(session.id, {
      modelId: session.model ?? config.models?.model ?? null,
      recallUserId: session.userId ?? null,
      recallQuery: null,
      config,
    });

    const { startWorkflow } = await import('@/lib/workflow/agent/dispatch');
    const { runId } = await startWorkflow({
      sessionId: session.id,
      initialMessages: [
        ...history,
        { role: 'user' as const, content: HEARTBEAT_WAKEUP_PROMPT },
      ],
      config,
      source: source as ChatSource,
      user,
      heartbeat: true,
    });

    logger.info('deliver:dispatched', {
      sessionId: session.id,
      runId,
      intervalMinutes: claimed.intervalMinutes,
    });
    return { status: 'dispatched', runId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('deliver:failed', { sessionId: session.id, error: message });
    await markFailed(message);
    throw error;
  }
}
