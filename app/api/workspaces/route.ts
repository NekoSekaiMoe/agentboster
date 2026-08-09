export const dynamic = 'force-dynamic';

import {
  createWorkspace,
  getOrCreateDefaultWorkspace,
  listWorkspacesByOwner,
} from '@/lib/core/db/agentd';
import { requireAuthAccess } from '@/lib/auth/access';
import { cloneBuiltinTemplates } from '@/lib/core/db/memory/builtin';
import { createLogger } from '@/lib/utils/logger';
import { cookies } from 'next/headers';

const logger = createLogger('api.workspaces');

/**
 * User-facing workspaces API (NOT to be confused with
 * /api/agentd/v1/project-sandboxes, which is the legacy path-B
 * "projectId ↔ sandbox" binding table).
 *
 * GET    — list the current user's workspaces (auto-creating a default
 *          workspace if the user has none yet, so the UI never renders an
 *          empty switcher).
 * POST   — create a new workspace (clones builtin templates so SOUL /
 *          IDENTITY / AGENTS / USER start from the global defaults).
 */
export async function GET() {
  const cookieStore = await cookies();
  const access = await requireAuthAccess(cookieStore);
  const ownerId = access.session.userId;

  // Ensure the user has at least one workspace. The migration script also
  // does this for legacy users, but this covers brand-new users and any
  // edge case where the migration hasn't run yet.
  await getOrCreateDefaultWorkspace(ownerId);

  const list = await listWorkspacesByOwner(ownerId);
  return Response.json({ success: true, data: list });
}

export async function POST(request: Request) {
  try {
    const cookieStore = await cookies();
    const access = await requireAuthAccess(cookieStore);
    const ownerId = access.session.userId;

    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
    };
    const name = body.name?.trim() || '未命名工作区';

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
    logger.error('workspace creation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to create workspace' },
      { status: 500 },
    );
  }
}
