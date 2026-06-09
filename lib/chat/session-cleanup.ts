import { getRun } from 'workflow/api';

import { deleteSession, deleteSessionForUser } from '@/lib/core/db/chat';
import { listScheduledTasksBySessionId } from '@/lib/core/db/scheduled';
import { stopSessionSandbox } from '@/lib/core/sandbox';
import { abortAgentdSession } from '@/lib/extra/agent/agentd-tools-client';

type SessionForCleanup = {
  id: string;
  sandboxId: string | null;
  workflowRunId: string | null;
};

export type ChatSessionCleanupResult = {
  daemonAborted: boolean;
  deleted: boolean;
  sandboxStopped: boolean;
  scheduleRunsCancelled: number;
  workflowCancelled: boolean;
};

async function cancelWorkflowRun(runId: string | null | undefined) {
  if (!runId) {
    return false;
  }

  try {
    await getRun(runId).cancel();
    return true;
  } catch {
    return false;
  }
}

export async function cleanupChatSession(
  session: SessionForCleanup,
  options?: {
    userId?: string;
  },
): Promise<ChatSessionCleanupResult> {
  const [daemonAborted, workflowCancelled, scheduledTasks] = await Promise.all([
    abortAgentdSession(session.id),
    cancelWorkflowRun(session.workflowRunId),
    listScheduledTasksBySessionId(session.id),
  ]);

  const scheduleRunsCancelled = await Promise.all(
    scheduledTasks.map((task) => cancelWorkflowRun(task.scheduleWorkflowRunId)),
  );

  let sandboxStopped = false;
  if (session.sandboxId) {
    try {
      await stopSessionSandbox(session.id);
      sandboxStopped = true;
    } catch {
      sandboxStopped = false;
    }
  }

  const deletedSession = options?.userId
    ? await deleteSessionForUser(session.id, options.userId)
    : await deleteSession(session.id);

  return {
    daemonAborted,
    workflowCancelled,
    sandboxStopped,
    scheduleRunsCancelled: scheduleRunsCancelled.filter(Boolean).length,
    deleted: Boolean(deletedSession),
  };
}
