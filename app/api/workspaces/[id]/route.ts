export const dynamic = 'force-dynamic';

import { and, desc, eq, sql } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { requireAuthAccess } from '@/lib/auth/access';
import { cleanupChatSession } from '@/lib/chat/session-cleanup';
import { db } from '@/lib/core/db';
import {
  archiveWorkspace,
  deleteWorkspaceRow,
  migrateWorkspaceNode,
  renameWorkspace,
  resolveWorkspaceAccess,
  setDefaultWorkspace,
  setWorkspaceSharedMemory,
  setWorkspaceVisibility,
  type WorkspaceAccess,
} from '@/lib/core/db/agentd';
import { deleteSessionsByWorkspaceId, listSessions } from '@/lib/core/db/chat';
import { deleteBuiltinMemoriesByWorkspaceId } from '@/lib/core/db/memory/builtin';
import { deleteLongTermMemoriesByWorkspaceId } from '@/lib/core/db/memory/long-term';
import { agentdNodes, notifications, sessions } from '@/lib/core/db/schema';
import { computeNodeStatus } from '@/lib/extra/agent/node-liveness';
import { deriveContainerStatus } from '@/lib/extra/agent/workspace-status';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.workspaces.id');

/**
 * Single-workspace management API.
 *
 * GET    — workspace detail, aggregated with the bound node's effective
 *          health (computeNodeStatus — NEVER the raw agentd_nodes.status
 *          column), a derived container state, and the most recent
 *          workspace_failover notifications. Open to anyone who can
 *          ACCESS the workspace (owner / public / admin-manageable).
 * PATCH  — action-based single-purpose updates (manage-gated):
 *            { action: 'rename', name }
 *            { action: 'set_default' }          — actor must BE the owner
 *            { action: 'migrate_node', newNodeId? }
 *            { action: 'set_visibility', visibility }
 *              · public → private also deletes the shared memory pool and
 *                resets member-shared sessions back to private
 *            { action: 'set_shared_memory', enabled }  — public only;
 *              disabling deletes the shared memory pool
 * DELETE — archive (soft delete, manage-gated). Refused while the
 *          workspace is the owner's default — the owner must designate
 *          another default first, otherwise the next lazy default-create
 *          would silently mint a fresh workspace behind their back.
 *          `?hard=true` performs a HARD delete instead: shared pool +
 *          every long-term/builtin memory, all sessions (messages
 *          cascade) and the workspace row itself are removed, with a
 *          best-effort runtime cleanup per session first.
 *
 * Access rules (lib/core/db/agentd.ts): canAccessWorkspace /
 * canManageWorkspace. Manage = the owner, or an admin-role actor when the
 * workspace's owner has no owner/root role. Unknown id → 404, denied →
 * 403, before any mutation.
 */

const patchBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rename'), name: z.string().trim().min(1) }),
  z.object({ action: z.literal('set_default') }),
  z.object({
    action: z.literal('migrate_node'),
    newNodeId: z.string().trim().min(1).optional(),
  }),
  z.object({
    action: z.literal('set_visibility'),
    visibility: z.enum(['private', 'public']),
  }),
  z.object({
    action: z.literal('set_shared_memory'),
    enabled: z.boolean(),
  }),
]);

type RouteActor = { userId: string; roles: readonly string[] };

type AccessResult =
  | { access: WorkspaceAccess; actor: RouteActor; error?: never }
  | { access?: never; actor?: never; error: Response };

/** Load the workspace + compute the actor's access, mapping missing → 404
 *  and denied → 403. `level` picks the gate: 'access' for reads, 'manage'
 *  for mutations. */
async function requireWorkspaceAccess(
  id: string,
  level: 'access' | 'manage',
): Promise<AccessResult> {
  const cookieStore = await cookies();
  const auth = await requireAuthAccess(cookieStore);
  const actor: RouteActor = {
    userId: auth.session.userId,
    roles: auth.user.roles,
  };
  const access = await resolveWorkspaceAccess(id, actor);
  if (!access) {
    return {
      error: Response.json(
        { success: false, error: 'Workspace not found' },
        { status: 404 },
      ),
    };
  }
  const allowed = level === 'manage' ? access.canManage : access.canAccess;
  if (!allowed) {
    return {
      error: Response.json(
        { success: false, error: 'Forbidden' },
        { status: 403 },
      ),
    };
  }
  return { access, actor };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const gated = await requireWorkspaceAccess(id, 'access');
    if (gated.error) return gated.error;
    const { ws } = gated.access;

    // Bound node + effective health. computeNodeStatus combines the stored
    // (advisory) status with heartbeat freshness — reading agentd_nodes
    // .status raw is a known trap (nothing flips it offline reliably).
    let node: {
      nodeId: string;
      status: 'online' | 'offline';
      lastHeartbeat: Date | null;
    } | null = null;
    if (ws.preferredNodeId) {
      const [nodeRow] = await db
        .select({
          nodeID: agentdNodes.nodeID,
          status: agentdNodes.status,
          lastHeartbeat: agentdNodes.lastHeartbeat,
        })
        .from(agentdNodes)
        .where(eq(agentdNodes.nodeID, ws.preferredNodeId))
        .limit(1);
      node = nodeRow
        ? {
            nodeId: nodeRow.nodeID,
            status: computeNodeStatus(nodeRow.status, nodeRow.lastHeartbeat),
            lastHeartbeat: nodeRow.lastHeartbeat,
          }
        : // The node row vanished (zombie reap / re-register) — treat as
          // offline; the failover sweeper will unbind the workspace.
          {
            nodeId: ws.preferredNodeId,
            status: 'offline' as const,
            lastHeartbeat: null,
          };
    }

    // Recent failovers for this workspace (newest first). The payload's
    // workspace_id links the notification back; userId is the tenancy
    // filter (never trust payload alone for isolation).
    const recentFailovers = gated.access.canManage
      ? await db
          .select({
            id: notifications.id,
            createdAt: notifications.createdAt,
            payload: notifications.payload,
          })
          .from(notifications)
          .where(
            and(
              eq(notifications.userId, ws.ownerId),
              eq(notifications.notificationType, 'workspace_failover'),
              sql`${notifications.payload}->>'workspace_id' = ${ws.id}`,
            ),
          )
          .orderBy(desc(notifications.createdAt))
          .limit(5)
      : // Read-only callers (public-workspace members) get an empty list —
        // failover history is owner/admin operational detail.
        [];

    return Response.json({
      success: true,
      data: {
        ...ws,
        node,
        containerStatus: deriveContainerStatus(
          ws.preferredNodeId,
          node?.status ?? null,
        ),
        recentFailovers,
      },
    });
  } catch (error) {
    logger.error('workspace detail failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to load workspace' },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const gated = await requireWorkspaceAccess(id, 'manage');
    if (gated.error) return gated.error;
    const { ws } = gated.access;
    const { actor } = gated;
    const ownerId = ws.ownerId;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { success: false, error: 'Invalid JSON body' },
        { status: 400 },
      );
    }
    const parsed = patchBodySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        {
          success: false,
          error: 'Invalid patch body',
          issues: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    switch (parsed.data.action) {
      case 'rename': {
        const updated = await renameWorkspace(id, parsed.data.name);
        if (!updated) {
          return Response.json(
            { success: false, error: 'Workspace not found' },
            { status: 404 },
          );
        }
        logger.info('workspace renamed', { workspaceId: id, ownerId });
        return Response.json({ success: true, data: updated });
      }
      case 'set_default': {
        // The default flag is per workspace-OWNER, so only the owner
        // themselves may move it — an admin managing the workspace would
        // otherwise silently change someone else's default.
        if (actor.userId !== ws.ownerId) {
          return Response.json(
            {
              success: false,
              error: 'Only the workspace owner can set the default',
            },
            { status: 403 },
          );
        }
        const updated = await setDefaultWorkspace(ws.ownerId, id);
        if (!updated) {
          return Response.json(
            {
              success: false,
              error: 'Workspace is archived or not owned by you',
            },
            { status: 409 },
          );
        }
        logger.info('workspace set as default', { workspaceId: id, ownerId });
        return Response.json({ success: true, data: updated });
      }
      case 'migrate_node': {
        const newNodeId = parsed.data.newNodeId;
        if (newNodeId) {
          const [nodeRow] = await db
            .select({ nodeID: agentdNodes.nodeID })
            .from(agentdNodes)
            .where(eq(agentdNodes.nodeID, newNodeId))
            .limit(1);
          if (!nodeRow) {
            return Response.json(
              { success: false, error: 'Target node not found' },
              { status: 400 },
            );
          }
        }
        const updated = await migrateWorkspaceNode(id, newNodeId ?? null);
        if (!updated) {
          return Response.json(
            { success: false, error: 'Workspace is archived' },
            { status: 409 },
          );
        }
        logger.info('workspace node migrated', {
          workspaceId: id,
          ownerId,
          newNodeId: newNodeId ?? null,
          nodeGeneration: updated.nodeGeneration,
        });
        return Response.json({ success: true, data: updated });
      }
      case 'set_visibility': {
        const next = parsed.data.visibility;
        const updated = await setWorkspaceVisibility(id, next);
        if (!updated) {
          return Response.json(
            { success: false, error: 'Workspace is archived' },
            { status: 409 },
          );
        }
        let sharedMemoriesDeleted = 0;
        if (next === 'private') {
          // Going private revokes every member grant: drop the shared
          // memory pool (personal memories survive), force the pool
          // toggle off so a later re-public starts clean, and reset
          // member-shared sessions back to private — re-publishing the
          // workspace must not silently re-expose them.
          sharedMemoriesDeleted = await deleteLongTermMemoriesByWorkspaceId(
            id,
            { sharedOnly: true },
          );
          await db
            .update(sessions)
            .set({ visibility: 'private', updatedAt: new Date() })
            .where(
              and(
                eq(sessions.workspaceId, id),
                eq(sessions.visibility, 'shared'),
              ),
            );
        }
        // Reflect the persisted shared-memory toggle in the response: the
        // initial `updated` row predates the forced toggle-off and would
        // otherwise report a stale sharedMemoryEnabled:true.
        let result = updated;
        if (next === 'private' && updated.sharedMemoryEnabled) {
          const toggled = await setWorkspaceSharedMemory(id, false);
          if (toggled) result = toggled;
        }
        logger.info('workspace visibility changed', {
          workspaceId: id,
          ownerId,
          visibility: next,
          sharedMemoriesDeleted,
        });
        return Response.json({ success: true, data: result });
      }
      case 'set_shared_memory': {
        // The pool only exists inside PUBLIC workspaces — enabling it on
        // a private one would be a silent no-op for members.
        if (ws.visibility !== 'public') {
          return Response.json(
            {
              success: false,
              error: 'Shared memory is only available for public workspaces',
            },
            { status: 409 },
          );
        }
        const enabled = parsed.data.enabled;
        const updated = await setWorkspaceSharedMemory(id, enabled);
        if (!updated) {
          return Response.json(
            { success: false, error: 'Workspace is archived' },
            { status: 409 },
          );
        }
        let sharedMemoriesDeleted = 0;
        if (!enabled) {
          // Toggle off ⇒ the pool goes away (personal memories survive).
          sharedMemoriesDeleted = await deleteLongTermMemoriesByWorkspaceId(
            id,
            { sharedOnly: true },
          );
        }
        logger.info('workspace shared memory toggled', {
          workspaceId: id,
          ownerId,
          enabled,
          sharedMemoriesDeleted,
        });
        return Response.json({ success: true, data: updated });
      }
      default: {
        // Unreachable today (the discriminatedUnion rejects unknown
        // actions), but guards against future schema/switch drift — a new
        // action added to the schema without a matching case would
        // otherwise fall out of the switch and return undefined.
        return Response.json(
          { success: false, error: 'Invalid action' },
          { status: 400 },
        );
      }
    }
  } catch (error) {
    logger.error('workspace patch failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to update workspace' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const gated = await requireWorkspaceAccess(id, 'manage');
    if (gated.error) return gated.error;
    const { ws } = gated.access;

    // The default workspace cannot be removed directly: archiveWorkspace
    // would silently drop is_default, and the next GET /api/workspaces
    // would lazily mint a brand-new default behind the user's back.
    // Force an explicit "set another default first" choice instead.
    if (ws.isDefault) {
      return Response.json(
        {
          success: false,
          error:
            'Cannot delete the default workspace. Set another workspace as default first.',
        },
        { status: 409 },
      );
    }

    const hard = new URL(request.url).searchParams.get('hard') === 'true';
    if (hard) {
      // HARD DELETE: remove everything the workspace owns. Order matters:
      //  1. best-effort runtime cleanup for EVERY session — page through
      //     the full list (listSessions caps limit at 200, so a single
      //     call would silently skip sessions past the first page and
      //     delete them without cleanup);
      //  2. drop long-term + builtin memories (soft-FK'd, no cascade);
      //  3. delete sessions (messages/session_memories cascade via FK);
      //  4. delete the workspace row itself.
      const pageSize = 200;
      let cleanupsFailed = 0;
      // cleanupChatSession DELETES each session row on success, so a naive
      // fixed advancing offset would skip every session past the first
      // page (deletions shift later rows forward). Instead, advance the
      // offset ONLY by the rows on each page that remain undeleted — i.e.
      // the failed cleanups, which keep their rows. Because listSessions
      // orders by updatedAt DESC and nothing here touches updatedAt, the
      // undeleted failures stay parked in the leading positions while
      // deletions pull the still-unprocessed rows forward to exactly
      // `offset`; the next page therefore starts where we left off. This
      // also unblocks the pathological case where >= pageSize sessions
      // fail persistently: without the offset advance they would fill
      // every offset-0 page and sessions beyond the first page would
      // never get a cleanup attempt (runtime/remote-state leak).
      // processedSessionIds guards against re-processing (infinite loop)
      // if the ordering assumption is ever violated.
      const processedSessionIds = new Set<string>();
      let offset = 0;
      for (;;) {
        const page = await listSessions({
          workspaceId: id,
          limit: pageSize,
          offset,
        });
        if (page.length === 0) break;
        const fresh = page.filter(
          (session) => !processedSessionIds.has(session.id),
        );
        // With the offset invariant above, an all-processed page can only
        // happen if the ordering shifted underneath us — bail rather than
        // spin forever.
        if (fresh.length === 0) break;
        for (const session of fresh) {
          processedSessionIds.add(session.id);
        }
        const cleanupResults = await Promise.allSettled(
          fresh.map((session) => cleanupChatSession(session)),
        );
        const failedOnPage = cleanupResults.filter(
          (result) => result.status === 'rejected',
        ).length;
        cleanupsFailed += failedOnPage;
        // Only the undeleted rows still occupy positions ahead of the
        // remaining sessions; successful deletions shift later rows
        // forward and must NOT advance the offset.
        offset += page.length - (fresh.length - failedOnPage);
      }
      const memoriesDeleted = await deleteLongTermMemoriesByWorkspaceId(id);
      const builtinDeleted = await deleteBuiltinMemoriesByWorkspaceId(id);
      const sessionIds = await deleteSessionsByWorkspaceId(id);
      const deleted = await deleteWorkspaceRow(id);
      if (!deleted) {
        return Response.json(
          { success: false, error: 'Workspace not found' },
          { status: 404 },
        );
      }
      logger.info('workspace hard-deleted', {
        workspaceId: id,
        ownerId: ws.ownerId,
        sessionsDeleted: sessionIds.length,
        memoriesDeleted,
        builtinDeleted,
        cleanupsFailed,
      });
      return Response.json({
        success: true,
        data: {
          deleted: true,
          sessionsDeleted: sessionIds.length,
          memoriesDeleted,
          cleanupsFailed,
        },
      });
    }

    const archived = await archiveWorkspace(id);
    if (!archived) {
      return Response.json(
        { success: false, error: 'Workspace not found' },
        { status: 404 },
      );
    }
    logger.info('workspace archived', {
      workspaceId: id,
      ownerId: ws.ownerId,
    });
    return Response.json({ success: true, data: archived });
  } catch (error) {
    logger.error('workspace delete failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to delete workspace' },
      { status: 500 },
    );
  }
}
