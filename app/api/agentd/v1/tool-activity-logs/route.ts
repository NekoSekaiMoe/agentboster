export const dynamic = 'force-dynamic';

import { writeToolActivityLogs } from '@/lib/core/db/agentd';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.tool-activity-logs');

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const logs = await writeToolActivityLogs(
      Array.isArray(body) ? body : [body],
    );
    return Response.json({ success: true, data: logs });
  } catch (error) {
    logger.error('tool activity log write failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to write tool activity logs' },
      { status: 500 },
    );
  }
}
