import { requireAuthAccess } from '@/lib/auth/access';
import { listCanonicalReviewSpans } from '@/lib/core/trace/dal';
import { createLogger } from '@/lib/utils/logger';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

const logger = createLogger('api.config.audit-logs-download');

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

    const canonicalRows = await listCanonicalReviewSpans({
      userId: access.isAdmin ? undefined : access.session.userId,
      limit: 10000,
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
        if (from && log.createdAt < new Date(from)) return false;
        if (to && log.createdAt > new Date(to)) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 10000);
    const csvHeader =
      'Timestamp,Level,Decision,Score,Command,Reason,Task ID,Trace ID,Agent ID';
    const csvRows = logs.map((log) => {
      const timestamp = log.createdAt.toISOString();
      const command = `"${log.command.replace(/"/g, '""')}"`;
      const reason = log.reason ? `"${log.reason.replace(/"/g, '""')}"` : '';
      return `${timestamp},${log.level},${log.decision},${log.score ?? ''},${command},${reason},${log.taskId},${log.traceId},${log.agentId}`;
    });
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
