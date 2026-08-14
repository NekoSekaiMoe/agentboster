export const dynamic = 'force-dynamic';

import { ingestAgentdTraceCallback } from '@/lib/core/trace/receiver';
import { normalizeTraceCallback } from '@/lib/core/trace/protocol';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.tool-activity-logs');

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const items = Array.isArray(body) ? body : [body];
    const callbacks = items.map(normalizeTraceCallback);
    if (
      callbacks.some(
        (item) =>
          !item || item.kind !== 'span' || !item.envelope.type.startsWith('tool'),
      )
    ) {
      return Response.json(
        { success: false, error: 'Invalid canonical tool callback' },
        { status: 400 },
      );
    }
    const rows = await Promise.all(
      callbacks.map((item) => ingestAgentdTraceCallback(item!)),
    );
    return Response.json({
      success: true,
      data: rows,
    });
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
