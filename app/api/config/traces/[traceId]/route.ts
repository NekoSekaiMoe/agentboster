import { cookies } from 'next/headers';
import { getRun } from 'workflow/api';

import { AuthError, requireAuthAccess } from '@/lib/auth/access';
import { getTrace } from '@/lib/core/trace/query';
import { createLogger } from '@/lib/utils/logger';

export const dynamic = 'force-dynamic';

const logger = createLogger('api.config.trace-detail');

function normalizeWorkflowStatus(value: unknown) {
  if (typeof value !== 'string') return null;
  const status = value.toLowerCase();
  if (status === 'running' || status === 'pending') return 'running' as const;
  if (status === 'completed') return 'completed' as const;
  if (status === 'failed' || status === 'error') return 'failed' as const;
  if (status === 'cancelled' || status === 'canceled' || status === 'stopped') {
    return 'stopped' as const;
  }
  return null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ traceId: string }> },
) {
  try {
    const access = await requireAuthAccess(await cookies());
    const { traceId } = await params;
    const detail = await getTrace(traceId, {
      userId: access.isAdmin ? undefined : access.session.userId,
    });
    if (!detail) {
      return Response.json(
        { success: false, error: 'Trace not found' },
        { status: 404 },
      );
    }

    // The local session hint covers most runs. Ask Workflow for the live
    // status as a best effort so an old session row cannot make an active run
    // look stale while the detail view is open.
    try {
      const status = normalizeWorkflowStatus(await getRun(traceId).status);
      if (status) {
        detail.summary.status = status;
        if (status === 'running') {
          detail.summary.completedAt = null;
        }
      }
    } catch {
      // Expired workflow runs still have useful persisted events; keep them.
    }

    return Response.json({ success: true, data: detail });
  } catch (error) {
    if (error instanceof AuthError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    logger.error('trace detail failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to fetch trace' },
      { status: 500 },
    );
  }
}
