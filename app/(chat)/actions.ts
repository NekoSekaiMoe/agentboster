'use server';

import { readAuthSessionFromCookies } from '@/lib/auth';
import {
  deleteSession,
  getSession,
  listSessions,
  updateSession,
} from '@/lib/core/db/chat';
import { listScheduledTasksBySessionId } from '@/lib/core/db/scheduled';
import { stopSessionSandbox } from '@/lib/core/sandbox';
import { nowIso, patchWorkflowRuntime } from '@/lib/core/sandbox/runtime';
import {
  type SessionRuntimeResponse,
  getSessionRuntime,
} from '@/lib/core/sandbox/session-runtime';
import { createLogger } from '@/lib/utils/logger';
import { resumeToolApproval } from '@/lib/workflow/agent/dispatch';
import { cookies } from 'next/headers';
import { getRun } from 'workflow/api';
import { z } from 'zod';

const logger = createLogger('actions.chat');

const runtimeControlSchema = z.discriminatedUnion('target', [
  z.object({
    target: z.literal('workflow'),
    action: z.literal('cancel'),
  }),
  z.object({
    target: z.literal('sandbox'),
    action: z.literal('stop'),
  }),
  z.object({
    target: z.literal('approval'),
    action: z.enum(['approve', 'reject']),
    toolCallId: z.string().trim().min(1).optional(),
    comment: z.string().trim().optional(),
  }),
]);

async function requireAuth() {
  const cookieStore = await cookies();
  const authSession = await readAuthSessionFromCookies(cookieStore);

  if (!authSession) {
    throw new Error('Unauthorized');
  }

  return authSession;
}

async function cancelRun(runId: string | null | undefined) {
  if (!runId) {
    return;
  }

  try {
    await getRun(runId).cancel();
  } catch {
    // Best-effort cleanup: the run may already be completed or cancelled.
  }
}

export async function saveModelId(model: string) {
  await requireAuth();

  const cookieStore = await cookies();
  cookieStore.set('model-id', model);
}

export async function listRecentSessionsAction(limit = 30) {
  await requireAuth();

  const sessions = await listSessions({
    archived: false,
    limit,
  });

  return sessions.map((session) => ({
    id: session.id,
    title: session.title,
    channel: session.channel,
    createdAt: session.createdAt.toISOString(),
  }));
}

export async function updateSessionTitleAction(input: {
  id: string;
  title: string | null;
}) {
  await requireAuth();

  const id = input.id.trim();
  if (!id) {
    throw new Error('Missing session id');
  }

  const nextTitle = input.title?.trim() || null;
  const session = await updateSession(id, {
    title: nextTitle,
  });

  if (!session) {
    throw new Error('Session not found.');
  }

  return {
    ok: true as const,
  };
}

export async function deleteSessionAction(sessionId: string) {
  await requireAuth();

  const id = sessionId.trim();
  if (!id) {
    throw new Error('Missing session id');
  }

  const session = await getSession(id);
  if (!session) {
    throw new Error('Session not found.');
  }

  await cancelRun(session.workflowRunId);

  if (session.sandboxId) {
    try {
      await stopSessionSandbox(id);
    } catch {
      // Best-effort cleanup: sandbox may already be stopped.
    }
  }

  const scheduledTasks = await listScheduledTasksBySessionId(id);
  await Promise.all(
    scheduledTasks.map((task) => cancelRun(task.scheduleWorkflowRunId)),
  );

  await deleteSession(id);

  return {
    ok: true as const,
  };
}

export async function getSessionRuntimeAction(
  sessionId: string,
): Promise<SessionRuntimeResponse | null> {
  await requireAuth();

  const id = sessionId.trim();
  if (!id) {
    throw new Error('Missing session id');
  }

  return getSessionRuntime(id);
}

export async function controlSessionRuntimeAction(input: {
  sessionId: string;
  target: 'workflow' | 'sandbox' | 'approval';
  action: 'cancel' | 'stop' | 'approve' | 'reject';
  toolCallId?: string;
  comment?: string;
}): Promise<{ ok: true; runtime: SessionRuntimeResponse | null }> {
  await requireAuth();

  const id = input.sessionId.trim();
  if (!id) {
    throw new Error('Missing session id');
  }

  const session = await getSession(id);
  if (!session) {
    throw new Error('Session not found.');
  }

  const parsedInput = runtimeControlSchema.safeParse({
    target: input.target,
    action: input.action,
    toolCallId: input.toolCallId,
    comment: input.comment,
  });

  if (!parsedInput.success) {
    throw new Error(
      parsedInput.error.issues[0]?.message ?? 'Invalid control request.',
    );
  }

  const controlInput = parsedInput.data;
  const runtime = await getSessionRuntime(id);
  if (!runtime) {
    throw new Error('Session not found.');
  }

  if (controlInput.target === 'workflow') {
    if (!runtime.workflow.canCancel || !runtime.workflow.runId) {
      throw new Error('Workflow is not running.');
    }

    await cancelRun(runtime.workflow.runId);
    await updateSession(id, {
      workflowRunId: null,
      status: 'stopped',
    });
    await patchWorkflowRuntime(id, {
      phase: 'cancelled',
      stoppedAt: nowIso(),
      lastRunId: runtime.workflow.runId,
    });
    logger.info('workflow:cancelled', {
      sessionId: id,
      runId: runtime.workflow.runId,
    });
  } else if (controlInput.target === 'sandbox') {
    if (!runtime.sandbox.canStop) {
      throw new Error('Sandbox is not running.');
    }

    await stopSessionSandbox(id);
    logger.info('sandbox:stopped', {
      sessionId: id,
      sandboxId: runtime.sandbox.sandboxId,
    });
  } else {
    const latestApproval =
      (session.metadata?.latestApproval as
        | {
            toolCallId?: string;
            toolName?: string;
            hookToken?: string;
            requestedAt?: string;
          }
        | undefined) ?? undefined;

    const explicitToolCallId = controlInput.toolCallId?.trim();
    const toolCallId =
      explicitToolCallId ||
      runtime.approval.toolCallId ||
      latestApproval?.toolCallId ||
      '';
    const candidateHookTokens = Array.from(
      new Set(
        [
          latestApproval?.hookToken,
          runtime.workflow.runId
            ? `${runtime.workflow.runId}:${toolCallId}`
            : undefined,
          toolCallId,
        ].filter((value): value is string => Boolean(value)),
      ),
    );
    const comment = controlInput.comment?.trim() || undefined;

    if (!toolCallId) {
      throw new Error('No pending approval was found for this session.');
    }

    let resolvedHookToken: string | null = null;
    let lastResumeError: unknown = null;

    for (const hookToken of candidateHookTokens) {
      try {
        await resumeToolApproval(hookToken, {
          approved: controlInput.action === 'approve',
          comment,
          toolCallId,
        });
        resolvedHookToken = hookToken;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes('hook not found')) {
          throw error;
        }
        lastResumeError = error;
      }
    }

    if (!resolvedHookToken) {
      throw (
        lastResumeError ??
        new Error('No matching approval hook was found for this tool call.')
      );
    }

    await updateSession(id, {
      metadata: {
        ...(session.metadata ?? {}),
        latestApproval: {
          ...(latestApproval ?? {}),
          toolCallId,
          hookToken: resolvedHookToken,
          toolName:
            runtime.approval.toolName ?? latestApproval?.toolName ?? null,
          status: controlInput.action === 'approve' ? 'approved' : 'rejected',
          comment: comment ?? null,
          requestedAt:
            runtime.approval.requestedAt ?? latestApproval?.requestedAt ?? null,
          respondedAt: nowIso(),
        },
      },
    });

    logger.info('approval:responded', {
      sessionId: id,
      toolCallId,
      action: controlInput.action,
    });
  }

  return {
    ok: true,
    runtime: await getSessionRuntime(id),
  };
}
