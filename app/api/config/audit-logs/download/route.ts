import { requireAuthAccess } from '@/lib/auth/access';
import {
  CANONICAL_QUERY_LIMIT_MAX,
  listCanonicalReviewSpans,
} from '@/lib/core/trace/dal';
import { createLogger } from '@/lib/utils/logger';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

const logger = createLogger('api.config.audit-logs-download');

const DEFAULT_DOWNLOAD_LIMIT = 10000;

function parseLimit(value: string | null): number {
  const parsed = Number(value ?? DEFAULT_DOWNLOAD_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_DOWNLOAD_LIMIT;
  return Math.min(Math.max(Math.trunc(parsed), 1), CANONICAL_QUERY_LIMIT_MAX);
}

/**
 * CSV field encoder:
 * - empty/null stays an empty string;
 * - values containing commas, quotes or newlines are quoted with `"` escaped;
 * - values starting with =, +, -, or @ get a leading apostrophe so spreadsheet
 *   apps do not evaluate them as formulas (CSV injection).
 */
export function csvField(value: string | number | null | undefined): string {
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
    const cookieStore = await cookies();
    const access = await requireAuthAccess(cookieStore);
    const { searchParams } = new URL(request.url);
    const level = searchParams.get('level');
    const decision = searchParams.get('decision');
    const search = searchParams.get('search');
    const taskId = searchParams.get('taskId');
    const agentId = searchParams.get('agentId');
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const limit = parseLimit(searchParams.get('limit'));

    const fromAt = from ? new Date(from) : null;
    if (from && (!fromAt || Number.isNaN(fromAt.getTime()))) {
      return NextResponse.json(
        { error: 'Invalid "from" timestamp' },
        { status: 400 },
      );
    }
    const toAt = to ? new Date(to) : null;
    if (to && (!toAt || Number.isNaN(toAt.getTime()))) {
      return NextResponse.json(
        { error: 'Invalid "to" timestamp' },
        { status: 400 },
      );
    }

    // listCanonicalReviewSpans only pushes userId/limit down; the rest stays
    // in-memory over the max canonical candidate pool.
    const canonicalRows = await listCanonicalReviewSpans({
      userId: access.isAdmin ? undefined : access.session.userId,
      limit: CANONICAL_QUERY_LIMIT_MAX,
    });
    const logs = canonicalRows
      .map((row) => {
        const metadata =
          row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
        return {
          traceId: row.traceId,
          taskId: row.taskId ?? '',
          agentId: row.agentId ?? '',
          command: typeof metadata.command === 'string' ? metadata.command : '',
          level:
            typeof metadata.level === 'string' ? metadata.level : 'unknown',
          decision:
            typeof metadata.decision === 'string'
              ? metadata.decision
              : row.status,
          score: typeof metadata.score === 'number' ? metadata.score : null,
          reason: typeof metadata.reason === 'string' ? metadata.reason : null,
          createdAt: row.startedAt,
        };
      })
      .filter((log) => {
        if (level && log.level !== level) return false;
        if (decision && log.decision !== decision) return false;
        if (
          search &&
          !log.command.toLowerCase().includes(search.toLowerCase())
        ) {
          return false;
        }
        if (taskId && log.taskId !== taskId) return false;
        if (agentId && log.agentId !== agentId) return false;
        if (fromAt && log.createdAt < fromAt) return false;
        if (toAt && log.createdAt > toAt) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
    const csvHeader =
      'Timestamp,Level,Decision,Score,Command,Reason,Task ID,Trace ID,Agent ID';
    const csvRows = logs.map((log) =>
      [
        csvField(log.createdAt.toISOString()),
        csvField(log.level),
        csvField(log.decision),
        csvField(log.score),
        csvField(log.command),
        csvField(log.reason),
        csvField(log.taskId),
        csvField(log.traceId),
        csvField(log.agentId),
      ].join(','),
    );
    return new NextResponse([csvHeader, ...csvRows].join('\n'), {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="audit-logs-${new Date().toISOString().split('T')[0]}.csv"`,
      },
    });
  } catch (error) {
    logger.error('Failed to download audit logs', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Failed to download audit logs' },
      { status: 500 },
    );
  }
}
