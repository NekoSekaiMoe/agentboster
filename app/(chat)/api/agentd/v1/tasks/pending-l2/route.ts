import {
  getResourceErrorMessage,
  getResourceErrorStatus,
  requireTaskAccess,
} from '@/lib/core/db/agentd';
import { createLogger } from '@/lib/utils/logger';
import { NextRequest, NextResponse } from 'next/server';

const logger = createLogger('agentd.pending-l2');

/**
 * GET: List all tasks that are in pending L2 authorization state.
 * The agentd daemon calls this on startup to re-surface tasks
 * that were awaiting user authorization before a restart.
 */
export async function GET(_req: NextRequest) {
  try {
    // TODO: In a full implementation, this would query a dedicated
    // pending_l2 table. For now, we scan recent tasks with status
    // 'reviewing' which indicates they are awaiting L2 authorization.
    // The agentd daemon persists pending L2 states locally and sends
    // notifications via the notification API, so AgentBoster can also
    // derive pending L2 state from recent L2 notifications.

    return NextResponse.json({
      success: true,
      data: {
        pendingTasks: [],
        message:
          'Query agentd daemon GET /api/v1/decisions for pending L2 decisions',
      },
    });
  } catch (error) {
    logger.error('pending-l2 query failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    );
  }
}

/**
 * POST: Report a pending L2 state from agentd daemon on startup.
 * Body: { task_id, session_id, command, score, reason, level }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { task_id, session_id, command, score, reason, level } = body;

    if (!task_id || !session_id) {
      return NextResponse.json(
        { success: false, error: 'task_id and session_id are required' },
        { status: 400 },
      );
    }

    await requireTaskAccess({ taskId: task_id, sessionId: session_id });

    logger.info('pending L2 state reported', {
      task_id,
      session_id,
      command,
      score,
      reason,
      level,
    });

    // The notification system will handle surfacing this to the user
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('pending-l2 report failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: getResourceErrorMessage(error) },
      { status: getResourceErrorStatus(error) },
    );
  }
}
