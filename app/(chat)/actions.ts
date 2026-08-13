'use server';

import { AuthError, requireAuthAccess } from '@/lib/auth/access';
import {
  assertCanManageSharedSession,
  resolveSessionGrant,
  type SessionGrant,
} from '@/lib/chat/session-access';
import {
  createSession,
  getSession,
  listSessions,
  listVisibleSessions,
  updateSession,
  updateSessionForUser,
  updateSessionMetadataKey,
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

  const grant = await assertCanManageSharedSession(access, existing);

  if (grant === 'owner') {
    await updateSessionForUser(sessionId, access.session.userId, {
      model: input.model,
    });
  } else {
    await updateSession(sessionId, { model: input.model });
  }

  return { ok: true };
}

export async function listRecentSessionsAction(
  options: { limit?: number; workspaceId?: string } = {},
) {
  const access = await requireAuth();
  const { limit = 30, workspaceId } = options;
  const userId = access.session.userId;

  // Visibility model (public/private sessions in shared workspaces):
  //   - the actor always sees their OWN sessions;
  //   - sessions in workspaces the actor can MANAGE are all listed
  //     (manage-only rows are annotated so the UI shows a lock instead
  //     of a chat link — content stays creator-only);
  //   - sessions with visibility='shared' in PUBLIC workspaces the actor
  //     can access are listed and readable.
  let rows: Awaited<ReturnType<typeof listVisibleSessions>>;
  if (workspaceId) {
    const { resolveWorkspaceAccess } = await import('@/lib/core/db/agentd');
    const wsAccess = access.isAdmin
      ? { canAccess: true, canManage: true }
      : await resolveWorkspaceAccess(workspaceId, {
          userId,
          roles: access.user.roles,
        });
    rows = await listVisibleSessions({
      userId,
      manageableWorkspaceIds: wsAccess?.canManage ? [workspaceId] : [],
      accessiblePublicWorkspaceIds:
        wsAccess?.canAccess && !wsAccess.canManage ? [workspaceId] : [],
      archived: false,
      limit,
      // Filter in SQL (before ORDER BY/LIMIT) so a workspace-scoped page
      // is full — post-filtering after LIMIT would return short pages.
      workspaceId,
    });
  } else if (access.isAdmin) {
    // Admins curate everything: full list, private content still locked.
    const all = await listSessions({ archived: false, limit });
    // Reuse resolveSessionGrant so manageOnly matches the chat /
    // orchestration read gates exactly: only a 'manage' grant (not a
    // readable one) renders as a lock — a shared session in a workspace
    // the admin cannot access stays locked instead of clickable.
    // resolveSessionGrant hits the DB per workspace, so memoize per
    // (workspaceId, visibility): a non-owner row's grant depends only on
    // those two plus the actor. Cache the PROMISE (not the resolved
    // value) so concurrent rows share a single in-flight resolution.
    const grantCache = new Map<string, Promise<SessionGrant | null>>();
    rows = await Promise.all(
      all.map(async (row) => {
        let grant: SessionGrant | null;
        if (row.userId === userId) {
          grant = 'owner';
        } else {
          const cacheKey = `${row.workspaceId ?? ''}:${row.visibility ?? 'private'}`;
          let pending = grantCache.get(cacheKey);
          if (!pending) {
            pending = resolveSessionGrant(access, row);
            grantCache.set(cacheKey, pending);
          }
          grant = await pending;
        }
        return {
          ...row,
          // Fail closed: an unresolvable grant renders as locked.
          manageOnly: grant === null || grant === 'manage',
        };
      }),
    );
  } else {
    const { listVisibleWorkspaces } = await import('@/lib/core/db/agentd');
    const visible = await listVisibleWorkspaces(userId);
    rows = await listVisibleSessions({
      userId,
      manageableWorkspaceIds: visible
        .filter((w) => w.ownerId === userId)
        .map((w) => w.id),
      accessiblePublicWorkspaceIds: visible
        .filter((w) => w.ownerId !== userId)
        .map((w) => w.id),
      archived: false,
      limit,
    });
  }

  return rows.map((session) => ({
    id: session.id,
    title: session.title,
    channel: session.channel,
    createdAt: session.createdAt.toISOString(),
    pinned: Boolean(
      (session.metadata as Record<string, unknown> | null)?.pinned,
    ),
    workspaceId: session.workspaceId ? String(session.workspaceId) : null,
    visibility: session.visibility ?? 'private',
    manageOnly: session.manageOnly ?? false,
    isOwn: session.userId === userId,
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
  // Search matches message CONTENT, so it must stay within the readable
  // set: the actor's own sessions plus SHARED sessions in active public
  // workspaces. Manage-only rows (members' private sessions, admin
  // curation) are deliberately excluded — a payload match would leak
  // private content. Applies to admins too (private content is
  // creator-only for everyone).
  const accessFilter = sql`AND (
        s.user_id = ${userId}
        OR (s.visibility = 'shared' AND s.workspace_id IN (
          SELECT id FROM workspaces WHERE visibility = 'public' AND status = 'active'
        ))
      )`;

  const rows = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT s.id
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    WHERE s.archived = false
      ${accessFilter}
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
  const currentPinned = Boolean(
    (existing.metadata as Record<string, unknown> | null)?.pinned,
  );
  const grant = await assertCanManageSharedSession(access, existing);

  // Atomically patch metadata.pinned via jsonb_set instead of a
  // read-modify-write of the whole metadata column. sessions.metadata is
  // concurrently written by several paths (contextUsage, latestApproval,
  // AGENTS.md persistence); a full-column `set({ metadata })` here would
  // race and silently clobber one of those writes (TOCTOU). The getSession
  // read above is still needed for authorization and to compute the
  // toggled value — only the WRITE is atomic. Owner grants use the
  // user-scoped variant (defense in depth), mirroring
  // saveSessionPersonaAction.
  const updated = await updateSessionMetadataKey(
    id,
    grant === 'owner' ? access.session.userId : null,
    'pinned',
    !currentPinned,
  );

  // updateSessionMetadataKey returns null on not-found / owner mismatch —
  // surface that as a failure instead of pretending the pin was toggled.
  if (!updated) {
    throw new Error('Session not found or access denied');
  }

  return { ok: true as const, pinned: !currentPinned };
}

/**
 * Result contract for session mutations consumed by the workspace
 * sessions table (components/config/sections/workspace-sessions-table.tsx).
 * Expected failures are RETURNED, not thrown, so the client can map the
 * error code to a localized toast without parsing exception messages.
 *
 * CONTRACT: this structured-failure result is deliberate and EVERY caller
 * must inspect `result.success` before applying UI side effects (cache-row
 * removal, navigation, success toasts). A `catch` around the action only
 * sees unexpected throws — forbidden / not_found / unknown come back as
 * normal returns. Treating this like a throw-on-failure API is a breaking
 * contract change: callers written against the old assumption silently
 * drop rows and redirect on failure (see chat-container.tsx,
 * chat-sidebar.tsx for the fixed call sites).
 */
type SessionMutationResult =
  | { success: true }
  | {
      success: false;
      error: 'invalid_input' | 'forbidden' | 'not_found' | 'unknown';
    };

const sessionVisibilitySchema = z.enum(['private', 'shared']);

/**
 * Toggle a session's visibility inside its PUBLIC workspace ('private' =
 * creator-only, 'shared' = every workspace member can read/manage).
 * Visibility is the CREATOR's choice — only grant==='owner' may change it;
 * workspace managers curate private sessions (rename/delete) but must not
 * flip them shared, which would expose content the member chose to hide.
 */
export async function setSessionVisibilityAction(input: {
  id: string;
  visibility: 'private' | 'shared';
}): Promise<SessionMutationResult> {
  const access = await requireAuth();

  // Runtime validation: server-action payloads are not type-checked, so
  // the declared 'private' | 'shared' type is only a compile-time hint.
  const parsedVisibility = sessionVisibilitySchema.safeParse(input.visibility);
  if (!parsedVisibility.success) {
    return { success: false, error: 'invalid_input' };
  }
  const visibility = parsedVisibility.data;

  const id = input.id.trim();
  if (!id) {
    return { success: false, error: 'invalid_input' };
  }

  const existing = await getSession(id);
  if (!existing) {
    return { success: false, error: 'not_found' };
  }

  let grant: SessionGrant;
  try {
    grant = await assertCanManageSharedSession(access, existing);
  } catch (error) {
    if (error instanceof AuthError) {
      return { success: false, error: 'forbidden' };
    }
    throw error;
  }
  if (grant !== 'owner') {
    return { success: false, error: 'forbidden' };
  }

  if (visibility === 'shared') {
    // Sharing only makes sense inside a PUBLIC, ACTIVE workspace — refuse
    // to silently no-op elsewhere. The status check matches the session
    // search filter above and setWorkspaceVisibility ('archived workspaces
    // stay out of the shared surface'): archiveWorkspace leaves visibility
    // at 'public', so without it an archived workspace's sessions could
    // still be flipped to shared.
    if (!existing.workspaceId) {
      return { success: false, error: 'invalid_input' };
    }
    const { resolveWorkspaceAccess } = await import('@/lib/core/db/agentd');
    const wsAccess = await resolveWorkspaceAccess(existing.workspaceId, {
      userId: access.session.userId,
      roles: access.user.roles,
    });
    if (
      wsAccess?.ws.visibility !== 'public' ||
      wsAccess.ws.status !== 'active'
    ) {
      return { success: false, error: 'invalid_input' };
    }
  }

  await updateSessionForUser(id, access.session.userId, { visibility });
  return { success: true };
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
    const grant = await assertCanManageSharedSession(access, existing);
    if (grant === 'owner') {
      await updateSessionForUser(id, access.session.userId, {
        title: nextTitle,
      });
    } else {
      await updateSession(id, { title: nextTitle });
    }
  }

  return {
    ok: true as const,
  };
}

export async function deleteSessionAction(
  sessionId: string,
): Promise<SessionMutationResult> {
  const access = await requireAuth();

  const id = sessionId.trim();
  if (!id) {
    return { success: false, error: 'invalid_input' };
  }

  const session = await getSession(id);
  if (!session) {
    return { success: false, error: 'not_found' };
  }

  let grant: SessionGrant;
  try {
    grant = await assertCanManageSharedSession(access, session);
  } catch (error) {
    if (error instanceof AuthError) {
      return { success: false, error: 'forbidden' };
    }
    throw error;
  }

  try {
    const cleanup = await cleanupChatSession(session, {
      userId: grant === 'owner' ? access.session.userId : undefined,
    });

    if (!cleanup.deleted) {
      return { success: false, error: 'not_found' };
    }
  } catch (error) {
    logger.error('session:delete-failed', {
      sessionId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    return { success: false, error: 'unknown' };
  }

  return { success: true };
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
  await assertCanManageSharedSession(access, session);

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
  await assertCanManageSharedSession(access, session);

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

export type PersonaOption = {
  /** The agentName key in config.agents (passed back as `agent` in the request body). */
  name: string;
  /** Display label for the picker. */
  label: string;
  /** Short description (first line of the system_prompt, when available). */
  description: string;
  /** Whether this persona has its own model override. */
  hasModelOverride: boolean;
};

/**
 * List the available chat personas for the Web picker. Always includes the
 * implicit "main" agent (even when config.agents.main is unset, because the
 * default system prompt + global model apply). Other entries come from
 * config.agents. Order: main first, then alphabetical.
 *
 * The picker is read-only for non-admins — they can SELECT any persona the
 * admin has configured, but only admins can CREATE / EDIT personas (still
 * done via the existing /config/agents admin form). This action is therefore
 * safe to call from any authed session.
 */
export async function listChatPersonasAction(): Promise<{
  personas: PersonaOption[];
}> {
  await requireAuth();
  const config = await getConfig();

  const personas: PersonaOption[] = [];
  const agents = config.agents ?? {};

  // "main" is always available even when config.agents.main is unset —
  // buildSystemPrompt falls back to DEFAULT_SYSTEM_PROMPT in that case.
  const mainAgent = agents.main;
  personas.push({
    name: 'main',
    label: 'Default',
    description:
      mainAgent?.system_prompt?.trim().split('\n')[0]?.slice(0, 120) ??
      'The default assistant persona.',
    hasModelOverride: Boolean(mainAgent?.model),
  });

  for (const [name, agent] of Object.entries(agents)) {
    if (name === 'main') continue;
    personas.push({
      name,
      label: name,
      description:
        agent.system_prompt?.trim().split('\n')[0]?.slice(0, 120) ??
        'Custom persona.',
      hasModelOverride: Boolean(agent.model),
    });
  }

  personas.sort((a, b) => {
    if (a.name === 'main') return -1;
    if (b.name === 'main') return 1;
    return a.label.localeCompare(b.label);
  });

  return { personas };
}

/**
 * Persist the selected persona onto the session so it survives reloads /
 * regenerations. Stored on session.metadata.agent (not a new column) to
 * avoid a schema migration for a UI-only preference. chatMain reads it back
 * from the session when the request body doesn't carry an explicit override
 * (e.g. on regenerate).
 */
export async function saveSessionPersonaAction(input: {
  sessionId: string;
  agent: string | null;
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
  const grant = await assertCanManageSharedSession(access, existing);

  const agent = input.agent?.trim() || null;

  // Atomically patch metadata.agent via jsonb_set instead of a read-modify-
  // write of the whole metadata column. sessions.metadata is concurrently
  // written by several paths (contextUsage, latestApproval, AGENTS.md
  // persistence); a full-column `set({ metadata })` here would race and
  // silently clobber one of those writes (TOCTOU).
  const updated = await updateSessionMetadataKey(
    sessionId,
    grant === 'owner' ? access.session.userId : null,
    'agent',
    agent,
  );

  // updateSessionMetadataKey returns null on not-found / owner mismatch.
  // We already checked the session exists and the caller can access it, so
  // a null here means the owner check inside the atomic UPDATE raced and the
  // row no longer matches — surface that as a failure instead of pretending
  // the persona was saved.
  if (!updated) {
    throw new Error('Session not found or access denied');
  }

  return { ok: true };
}
