export const dynamic = 'force-dynamic';

import {
  createTask,
  formatTaskForAgentd,
  getResourceErrorMessage,
  getResourceErrorStatus,
  listTasks,
  resolveAgentdResourceAccess,
} from '@/lib/core/db/agentd';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.tasks');

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const task = await createTask({
      agentId: body.agent_id ?? 'default',
      sessionId: body.session_id,
      command: body.command,
      sandboxType: body.sandbox_type,
      sandboxId: body.sandbox_id,
      env: body.env,
      timeout: body.timeout,
      // When the daemon createTask caller carries node_id, grant the lease
      // at create time so the first heartbeat renews it. The daemon is
      // the only caller that knows its node_id; identity is trusted from
      // the mTLS + AGENTD_API_KEY boundary, never a user_id body field.
      ownerNodeId: typeof body.node_id === 'string' ? body.node_id : undefined,
    });
    logger.info('task created', { taskId: task.id, agentId: task.agentId });
    return Response.json({ success: true, data: formatTaskForAgentd(task) });
  } catch (error) {
    logger.error('task creation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    const status = getResourceErrorStatus(error);
    return Response.json(
      { success: false, error: getResourceErrorMessage(error) },
      { status },
    );
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get('agent_id') ?? 'default';
    const sessionId = searchParams.get('session_id') ?? undefined;
    if (!sessionId) {
      return Response.json(
        { success: false, error: 'session_id is required' },
        { status: 400 },
      );
    }
    // Validate `limit` before it reaches listTasks: reject NaN, Infinity,
    // non-integers, and non-positive values; cap at MAX_PAGE_SIZE so a
    // hostile/misconfigured caller can't request unbounded scans. Absent
    // → default of 50.
    const MAX_PAGE_SIZE = 200;
    const DEFAULT_LIMIT = 50;
    const limitParam = searchParams.get('limit');
    let limit: number;
    if (limitParam === null) {
      limit = DEFAULT_LIMIT;
    } else {
      const parsed = Number(limitParam);
      if (
        !Number.isFinite(parsed) ||
        !Number.isInteger(parsed) ||
        parsed <= 0
      ) {
        return Response.json(
          {
            success: false,
            error:
              'limit must be a positive integer (1-200), or omitted for the default of 50',
          },
          { status: 400 },
        );
      }
      limit = Math.min(parsed, MAX_PAGE_SIZE);
    }
    const access = await resolveAgentdResourceAccess({ sessionId });
    const tasks = await listTasks(agentId, limit, {
      sessionId,
      userId: access.userId,
    });
    return Response.json({
      success: true,
      data: tasks.map((task) => formatTaskForAgentd(task)),
    });
  } catch (error) {
    if (getResourceErrorStatus(error) !== 500) {
      return Response.json(
        { success: false, error: getResourceErrorMessage(error) },
        { status: getResourceErrorStatus(error) },
      );
    }
    logger.error('list tasks failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Internal error' },
      { status: 500 },
    );
  }
}
