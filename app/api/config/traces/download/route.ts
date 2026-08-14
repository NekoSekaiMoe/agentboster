import { cookies } from 'next/headers';

import { AuthError, requireAuthAccess } from '@/lib/auth/access';
import { listTraces } from '@/lib/core/trace/query';
import { createLogger } from '@/lib/utils/logger';

export const dynamic = 'force-dynamic';

const logger = createLogger('api.config.trace-download');

function csv(value: string | number | null) {
  const text = value === null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export async function GET() {
  try {
    const access = await requireAuthAccess(await cookies());
    const traces = await listTraces(
      { userId: access.isAdmin ? undefined : access.session.userId },
      { limit: 250 },
    );
    const header =
      'Trace ID,Status,Started At,Completed At,Duration (ms),Models,Tools,Reviews,Failures,Tokens,Session ID,User ID';
    const rows = traces.map((trace) =>
      [
        trace.traceId,
        trace.status,
        trace.startedAt,
        trace.completedAt,
        trace.durationMs,
        trace.modelStepCount,
        trace.toolCount,
        trace.reviewCount,
        trace.failureCount,
        trace.totalTokens,
        trace.sessionId,
        trace.userId,
      ]
        .map((value) => csv(value))
        .join(','),
    );
    return new Response([header, ...rows].join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="traces-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    logger.error('trace export failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to export traces' },
      { status: 500 },
    );
  }
}
