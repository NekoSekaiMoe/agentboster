export const dynamic = 'force-dynamic';

import {
  createWorkspace,
  getOrCreateDefaultWorkspace,
  listVisibleWorkspaces,
} from '@/lib/core/db/agentd';
import { AuthError, requireAuthAccess } from '@/lib/auth/access';
import { cloneBuiltinTemplates } from '@/lib/core/db/memory/builtin';
import {
  deriveContainerStatus,
  getWorkspaceNodeStatuses,
} from '@/lib/extra/agent/workspace-status';
import { createLogger } from '@/lib/utils/logger';
import { cookies } from 'next/headers';

const logger = createLogger('api.workspaces');

/**
 * User-facing workspaces API (NOT to be confused with
 * /api/agentd/v1/project-sandboxes, which is the legacy path-B
 * "projectId ↔ sandbox" binding table).
 *
 * GET    — list the workspaces the current user may ENTER: their own
 *          (auto-creating a default workspace if they have none yet, so
 *          the UI never renders an empty switcher) plus other users'
 *          public active workspaces (labelled with ownerName). Each item
 *          is enriched with the bound node's effective status (ONE
 *          batched query, no N+1) and a derived container status for the
 *          switcher's status dot.
 * POST   — create a new workspace (clones builtin templates so SOUL /
 *          IDENTITY / AGENTS / USER start from the global defaults).
 */
export async function GET() {
  try {
    const cookieStore = await cookies();
    const access = await requireAuthAccess(cookieStore);
    const ownerId = access.session.userId;

    // Ensure the user has at least one workspace. The migration script also
    // does this for legacy users, but this covers brand-new users and any
    // edge case where the migration hasn't run yet.
    await getOrCreateDefaultWorkspace(ownerId);

    const list = await listVisibleWorkspaces(ownerId);
    const nodeStatuses = await getWorkspaceNodeStatuses(
      list.map((ws) => ws.preferredNodeId).filter((id): id is string => !!id),
    );
    const data = list.map((ws) => {
      const nodeStatus = ws.preferredNodeId
        ? (nodeStatuses.get(ws.preferredNodeId) ?? 'offline')
        : null;
      return {
        ...ws,
        // Don't leak another user's id with their public workspace —
        // undefined keys are dropped from the JSON response; ownerName
        // remains for UI labeling.
        ownerId: ws.ownerId === ownerId ? ws.ownerId : undefined,
        nodeStatus,
        containerStatus: deriveContainerStatus(ws.preferredNodeId, nodeStatus),
      };
    });
    return Response.json({ success: true, data });
  } catch (error) {
    // Only AuthError carries an HTTP status (401/403). Any other throw
    // is a 5xx and must not be mislabeled as an auth failure.
    if (error instanceof AuthError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    logger.error('workspace listing failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to list workspaces' },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const cookieStore = await cookies();
    const access = await requireAuthAccess(cookieStore);
    const ownerId = access.session.userId;

    // Runtime validation (no type assertions): the body must be valid
    // JSON, and `name` — when present — must be a string. Anything else
    // is a client error, not a reason to silently fall back to defaults.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { success: false, error: 'Invalid JSON body' },
        { status: 400 },
      );
    }

    const nameField =
      body !== null && typeof body === 'object' && 'name' in body
        ? (body as { name: unknown }).name
        : undefined;
    if (nameField !== undefined && typeof nameField !== 'string') {
      return Response.json(
        { success: false, error: 'Workspace name must be a string' },
        { status: 400 },
      );
    }

    const trimmedName = typeof nameField === 'string' ? nameField.trim() : '';
    const name = trimmedName || '未命名工作区';

    const ws = await createWorkspace({ ownerId, name });
    // Clone builtin templates so the new workspace has its own SOUL /
    // IDENTITY / AGENTS / USER starting from the global defaults. Failures
    // here are non-fatal — the workspace is usable without them (recall
    // falls through to the global rows via `workspace_id IS NULL`).
    try {
      await cloneBuiltinTemplates(ws.id);
    } catch (cloneError) {
      logger.warn('builtin template clone failed (non-fatal)', {
        workspaceId: ws.id,
        error:
          cloneError instanceof Error ? cloneError.message : String(cloneError),
      });
    }

    logger.info('workspace created', {
      workspaceId: ws.id,
      ownerId,
      name,
    });
    return Response.json({ success: true, data: ws }, { status: 201 });
  } catch (error) {
    // Same auth-status mapping as GET above.
    if (error instanceof AuthError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    logger.error('workspace creation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to create workspace' },
      { status: 500 },
    );
  }
}
