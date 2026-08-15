import { cookies } from 'next/headers';

import { AuthError, requireAuthAccess } from '@/lib/auth/access';
import { listTraces } from '@/lib/core/trace/query';
import { createLogger } from '@/lib/utils/logger';

export const dynamic = 'force-dynamic';

const logger = createLogger('api.config.trace-download');

const DEFAULT_DOWNLOAD_LIMIT = 250;
// listTraces clamps every limit to 250 (compactLimit) — anything larger is
// silently truncated there, so we cap the accepted request value to match.
const MAX_DOWNLOAD_LIMIT = 250;

function parseLimit(value: string | null): number {
  const parsed = Number(value ?? DEFAULT_DOWNLOAD_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_DOWNLOAD_LIMIT;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_DOWNLOAD_LIMIT);
}

/**
 * CSV field encoder:
 * - empty/null stays an empty string;
 * - values containing commas, quotes or newlines are quoted with `"` escaped;
 * - values starting with =, +, -, or @ get a leading apostrophe so spreadsheet
 *   apps do not evaluate them as formulas (CSV injection).
 */
function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) {
    text = `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export async function GET(request: Request) {
  try {
    const access = await requireAuthAccess(await cookies());
    const { searchParams } = new URL(request.url);
    // listTraces supports { limit, search } at the query level; status /
    // sessionId / from / to are filtered in memory on the returned
    // summaries (the candidate pool is fetched with a widened limit).
    const search = searchParams.get('search') ?? undefined;
    const limit = parseLimit(searchParams.get('limit'));
    const status = searchParams.get('status');
    const sessionId = searchParams.get('sessionId');
    const from = searchParams.get('from');
    const to = searchParams.get('to');

    const fromAt = from ? new Date(from) : null;
    if (from && (!fromAt || Number.isNaN(fromAt.getTime()))) {
      return Response.json(
        { success: false, error: 'Invalid "from" timestamp' },
        { status: 400 },
      );
    }
    const toAt = to ? new Date(to) : null;
    if (to && (!toAt || Number.isNaN(toAt.getTime()))) {
      return Response.json(
        { success: false, error: 'Invalid "to" timestamp' },
        { status: 400 },
      );
    }

    const traces = (
      await listTraces(
        { userId: access.isAdmin ? undefined : access.session.userId },
        { limit, search },
      )
    ).filter((trace) => {
      if (status && trace.status !== status) return false;
      if (sessionId && trace.sessionId !== sessionId) return false;
      if (
        fromAt &&
        (!trace.startedAt || trace.startedAt < fromAt.toISOString())
      )
        return false;
      if (toAt && (!trace.startedAt || trace.startedAt > toAt.toISOString()))
        return false;
      return true;
    });
    const header =
      'Trace ID,Status,Started At,Completed At,Duration (ms),Models,Tools,Reviews,Failures,Tokens,Session ID,User ID';
    const rows = traces.map((trace) =>
      [
        csvField(trace.traceId),
        csvField(trace.status),
        csvField(trace.startedAt),
        csvField(trace.completedAt),
        csvField(trace.durationMs),
        csvField(trace.modelStepCount),
        csvField(trace.toolCount),
        csvField(trace.reviewCount),
        csvField(trace.failureCount),
        csvField(trace.totalTokens),
        csvField(trace.sessionId),
        csvField(trace.userId),
      ].join(','),
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
