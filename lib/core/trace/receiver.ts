import {
  deriveSessionIdentity,
  getTask,
  resolveAgentdResourceAccess,
} from '@/lib/core/db/agentd';
import {
  ensureTraceRun,
  ingestTraceEvent,
  ingestTraceSpan,
  type TraceEnvelopeBase,
} from './dal';
import type { NormalizedTraceCallback } from './protocol';

/**
 * Ingest a canonical agentd callback after resolving its owner from the
 * server-side task/session rows. `user_id` in the wire payload is ignored.
 *
 * `resolveAgentdResourceAccess` keeps the 400/403/404 access semantics, but
 * it does not return the task/identity it resolved. To avoid re-deriving
 * them, we fetch the task once and reuse its sessionId to derive the
 * session identity, preserving the old role semantics.
 */
export async function ingestAgentdTraceCallback(
  callback: NormalizedTraceCallback,
) {
  const access = await resolveAgentdResourceAccess({
    taskId: callback.taskId,
    sessionId: callback.sessionId,
  });
  const task = callback.taskId ? await getTask(callback.taskId) : null;
  // Roles come from the SESSION identity (user-level roles), matching the
  // previous `deriveTaskIdentity` semantics. The task row already carries
  // sessionId, so one `getTask` + one `deriveSessionIdentity` replaces the
  // old triple query (resolveAgentdResourceAccess -> getTask ->
  // deriveTaskIdentity -> deriveSessionIdentity).
  const identity = await deriveSessionIdentity(
    task?.sessionId ?? callback.sessionId,
  );
  const envelope: TraceEnvelopeBase = {
    ...callback.envelope,
    userId: access.userId,
    sessionId: task?.sessionId ?? callback.sessionId,
    taskId: callback.taskId,
    workspaceId: task?.workspaceId,
    agentId: callback.envelope.agentId ?? task?.agentId ?? null,
    metadata: {
      ...(callback.envelope.metadata ?? {}),
      resolvedRoles: identity.roles,
      isAdmin: access.isAdmin,
    },
  };
  if (callback.kind === 'event') {
    return ingestTraceEvent({
      ...envelope,
      eventId: callback.envelope.eventId,
    });
  }
  if (callback.kind === 'run') {
    return ensureTraceRun({
      ...envelope,
      type: envelope.type || 'run',
    });
  }
  return ingestTraceSpan(envelope);
}
