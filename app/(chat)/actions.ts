'use server';

import {
  assertCanAccessOwnedResource,
  requireAuthAccess,
} from '@/lib/auth/access';
import {
  createSession,
  getSession,
  listSessions,
  updateSession,
  updateSessionForUser,
} from '@/lib/core/db/chat';
import { cleanupChatSession } from '@/lib/chat/session-cleanup';
import { stopSessionSandbox } from '@/lib/core/sandbox';
import { nowIso, patchWorkflowRuntime } from '@/lib/core/sandbox/runtime';
import { db } from '@/lib/core/db';
import { sql } from 'drizzle-orm';
import {
  type SessionRuntimeResponse,
  getSessionRuntime,
} from '@/lib/core/sandbox/session-runtime';
import { getConfig } from '@/lib/core/kv/config';
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
  return requireAuthAccess(cookieStore);
}

async function cancelRun(runId: string | null | undefined) {
  if (!runId) {
    return;
  }

  try {
    await getRun(runId).cancel();
  } catch {
    // Best-effort runtime control: the run may already be completed.
  }
}

export async function saveModelId(model: string) {
  await requireAuth();

  const cookieStore = await cookies();
  cookieStore.set('model-id', model);
}

export async function saveSessionModelAction(input: {
  sessionId: string;
  model: string | null;
}): Promise<{ ok: boolean }> {
  const access = await requireAuth();

  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    throw new Error('Missing session id');
  }

  const existing = await getSession(sessionId);
  if (!existing) {
    throw new Error('Session not found');
  }

  assertCanAccessOwnedResource(access, existing.userId);

  if (access.isAdmin) {
    await updateSession(sessionId, { model: input.model });
  } else {
    await updateSessionForUser(sessionId, access.session.userId, {
      model: input.model,
    });
  }

  return { ok: true };
}

export async function listRecentSessionsAction(limit = 30) {
  const access = await requireAuth();

  const sessions = await listSessions({
    archived: false,
    limit,
    ...(access.isAdmin ? {} : { userId: access.session.userId }),
  });

  return sessions.map((session) => ({
    id: session.id,
    title: session.title,
    channel: session.channel,
    createdAt: session.createdAt.toISOString(),
    pinned: Boolean(
      (session.metadata as Record<string, unknown> | null)?.pinned,
    ),
  }));
}

/**
 * Server-side session search. Matches session titles OR any message payload
 * (which includes all branched `versions[].parts[].text`). Returns the
 * matching session ids so the client can intersect with its loaded list.
 *
 * The payload::text ILIKE naturally covers every text fragment stored in the
 * jsonb — top-level parts, tool-call descriptions, and all alternate
 * versions — because it stringifies the whole payload before matching.
 */
export async function searchSessionsAction(query: string): Promise<string[]> {
  const access = await requireAuth();
  const q = query.trim();
  if (q.length < 2) return [];

  const escaped = q.replace(/[%_\\]/g, (m) => `\\${m}`);
  const pattern = `%${escaped}%`;
  const userId = access.session.userId;
  const userFilter = access.isAdmin ? sql`` : sql`AND s.user_id = ${userId}`;

  const rows = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT s.id
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    WHERE s.archived = false
      ${userFilter}
      AND (
        s.title ILIKE ${pattern} ESCAPE '\\'
        OR m.payload::text ILIKE ${pattern} ESCAPE '\\'
      )
    ORDER BY s.updated_at DESC
    LIMIT 30
  `);

  return rows.rows.map((r) => r.id);
}

export async function toggleSessionPinAction(input: { id: string }) {
  const access = await requireAuth();

  const id = input.id.trim();
  if (!id) {
    throw new Error('Missing session id');
  }

  const existing = await getSession(id);
  if (!existing) {
    throw new Error('Session not found');
  }
  assertCanAccessOwnedResource(access, existing.userId);

  const currentPinned = Boolean(
    (existing.metadata as Record<string, unknown> | null)?.pinned,
  );
  const nextMetadata = { ...(existing.metadata ?? {}), pinned: !currentPinned };

  if (access.isAdmin) {
    await updateSession(id, { metadata: nextMetadata });
  } else {
    await updateSessionForUser(id, access.session.userId, {
      metadata: nextMetadata,
    });
  }

  return { ok: true as const, pinned: !currentPinned };
}

export async function updateSessionTitleAction(input: {
  id: string;
  title: string | null;
}) {
  const access = await requireAuth();

  const id = input.id.trim();
  if (!id) {
    throw new Error('Missing session id');
  }

  const nextTitle = input.title?.trim() || null;
  const existing = await getSession(id);

  if (!existing) {
    await createSession({
      id,
      title: nextTitle,
      userId: access.session.userId,
    });
  } else {
    assertCanAccessOwnedResource(access, existing.userId);
    if (access.isAdmin) {
      await updateSession(id, { title: nextTitle });
    } else {
      await updateSessionForUser(id, access.session.userId, {
        title: nextTitle,
      });
    }
  }

  return {
    ok: true as const,
  };
}

export async function deleteSessionAction(sessionId: string) {
  const access = await requireAuth();

  const id = sessionId.trim();
  if (!id) {
    throw new Error('Missing session id');
  }

  const session = await getSession(id);
  if (!session) {
    throw new Error('Session not found.');
  }
  assertCanAccessOwnedResource(access, session.userId);

  const cleanup = await cleanupChatSession(session, {
    userId: access.isAdmin ? undefined : access.session.userId,
  });

  if (!cleanup.deleted) {
    throw new Error('Session not found.');
  }

  return {
    ok: true as const,
  };
}

export async function getSessionRuntimeAction(
  sessionId: string,
): Promise<SessionRuntimeResponse | null> {
  const access = await requireAuth();

  const id = sessionId.trim();
  if (!id) {
    throw new Error('Missing session id');
  }

  const session = await getSession(id);
  if (!session) {
    return null;
  }
  assertCanAccessOwnedResource(access, session.userId);

  return getSessionRuntime(id);
}

export async function controlSessionRuntimeAction(input: {
  sessionId: string;
  target: 'workflow' | 'sandbox' | 'approval';
  action: 'cancel' | 'stop' | 'approve' | 'reject';
  toolCallId?: string;
  comment?: string;
}): Promise<{ ok: true; runtime: SessionRuntimeResponse | null }> {
  const access = await requireAuth();

  const id = input.sessionId.trim();
  if (!id) {
    throw new Error('Missing session id');
  }

  const session = await getSession(id);
  if (!session) {
    throw new Error('Session not found.');
  }
  assertCanAccessOwnedResource(access, session.userId);

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

export async function isAgentdEnabled(): Promise<boolean> {
  const config = await getConfig();
  return config.agentd?.enabled ?? false;
}

export async function getChatUiSettingsAction(): Promise<{
  enterToSend: boolean;
}> {
  await requireAuth();

  const config = await getConfig();
  return {
    enterToSend: config.chat?.enter_to_send ?? true,
  };
}
