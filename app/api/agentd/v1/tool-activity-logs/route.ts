export const dynamic = 'force-dynamic';

import { writeToolActivityLogs } from '@/lib/core/db/agentd';
import { ingestAgentdTraceCallback } from '@/lib/core/trace/receiver';
import { normalizeTraceCallback } from '@/lib/core/trace/protocol';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.tool-activity-logs');

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const items = Array.isArray(body) ? body : [body];
    const canonical = items
      .map(normalizeTraceCallback)
      .filter(
        (item): item is NonNullable<ReturnType<typeof normalizeTraceCallback>> =>
          item !== null &&
          item.kind === 'span' &&
          item.envelope.type.startsWith('tool'),
      );
    const legacy = items.filter((item) => !normalizeTraceCallback(item));
    const [canonicalRows, legacyRows] = await Promise.all([
      Promise.all(canonical.map(ingestAgentdTraceCallback)),
      legacy.length ? writeToolActivityLogs(legacy) : Promise.resolve([]),
    ]);
    return Response.json({
      success: true,
      data: [...canonicalRows, ...legacyRows.map((row) => ({ ...row, legacy: true }))],
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
