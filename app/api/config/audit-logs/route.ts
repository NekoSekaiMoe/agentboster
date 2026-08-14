import { requireAuthAccess } from '@/lib/auth/access';
import { listCanonicalReviewSpans } from '@/lib/core/trace/dal';
import { createLogger } from '@/lib/utils/logger';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

const logger = createLogger('api.config.audit-logs');

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
          id: row.id,
          taskId: row.taskId,
          traceId: row.traceId,
          userId: row.userId,
          roles: [],
          command: typeof metadata.command === 'string' ? metadata.command : '',
          level:
            typeof metadata.level === 'string' ? metadata.level : 'unknown',
          score: typeof metadata.score === 'number' ? metadata.score : null,
          decision:
            typeof metadata.decision === 'string'
              ? metadata.decision
              : row.status,
          reason: typeof metadata.reason === 'string' ? metadata.reason : null,
          createdAt: row.startedAt,
          agentId: row.agentId,
          sessionId: row.sessionId,
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
      .slice(0, 1000);

    return NextResponse.json(logs);
  } catch (error) {
    logger.error('Failed to fetch audit logs', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Failed to fetch audit logs' },
      { status: 500 },
    );
  }
}
