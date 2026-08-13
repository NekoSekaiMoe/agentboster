export const dynamic = 'force-dynamic';

import {
  formatTaskForAgentd,
  getTask,
  updateTaskStatus,
} from '@/lib/core/db/agentd';
import { agentTasks } from '@/lib/core/db/schema';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.tasks');

// Whitelist for body.status. agent_tasks.status is a text column with NO
// DB-level CHECK constraint (the drizzle enum is TS-only), so without
// this guard an arbitrary string would be written — it would never match
// the terminal statuses (lease never cleared), never match
// reapOrphanedTasks' in-flight scan, and never be claimable: a
// permanently stuck row. Derived from the schema enum so the route can
// never drift from the column definition.
const VALID_TASK_STATUSES: ReadonlySet<string> = new Set(
  agentTasks.status.enumValues,
);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) {
    return Response.json(
      { success: false, error: 'Task not found' },
      { status: 404 },
    );
  }
  return Response.json({ success: true, data: formatTaskForAgentd(task) });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  if (typeof body.status !== 'string' || !VALID_TASK_STATUSES.has(body.status)) {
    return Response.json(
      {
        success: false,
        error: `Invalid status; must be one of: ${[...VALID_TASK_STATUSES].join(', ')}`,
      },
      { status: 400 },
    );
  }
  // When the daemon carries node_id, pass it as the owner guard: a status
  // mutation from a node that does NOT own the row is rejected (returns
  // null) so a stale daemon returning after its lease expired cannot
  // clobber the recovery another node performed. Identity is trusted from
  // the mTLS + AGENTD_API_KEY boundary.
  const ownerNodeId =
    typeof body.node_id === 'string' ? body.node_id : undefined;
  const task = await updateTaskStatus(id, body.status, body.result, {
    ownerNodeId,
  });
  if (!task && ownerNodeId) {
    // Either the task doesn't exist OR the caller doesn't own it. Both map
    // to 409 — distinguish with a getTask if a precise 404 is needed, but
    // for the daemon client a 409 is actionable ("you lost ownership,
    // refetch") regardless.
    logger.warn('task update rejected (not owner or missing)', {
      taskId: id,
      status: body.status,
      ownerNodeId,
    });
    return Response.json(
      { success: false, error: 'Task not owned by this node' },
      { status: 409 },
    );
  }
  logger.info('task updated', { taskId: id, status: body.status });
  return Response.json({
    success: true,
    data: task ? formatTaskForAgentd(task) : null,
  });
}
