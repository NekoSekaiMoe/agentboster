import { requireAuthAccess } from '@/lib/auth/access';
import { db } from '@/lib/core/db';
import { agentToolActivityLogs } from '@/lib/core/db/schema';
import { listCanonicalToolSpans } from '@/lib/core/trace/dal';
import { createLogger } from '@/lib/utils/logger';
import { type SQL, and, desc, eq, gte, ilike, lte, or } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

const logger = createLogger('api.config.tool-activity-logs');

function parseLimit(value: string | null): number {
  const parsed = Number(value ?? 500);
  if (!Number.isFinite(parsed)) {
    return 500;
  }
  return Math.min(Math.max(Math.trunc(parsed), 1), 1000);
}

export async function GET(request: Request) {
  try {
    const cookieStore = await cookies();
    const access = await requireAuthAccess(cookieStore);

    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action');
    const toolName = searchParams.get('toolName');
    const search = searchParams.get('search');
    const taskId = searchParams.get('taskId');
    const sessionId = searchParams.get('sessionId');
    const agentId = searchParams.get('agentId');
    const success = searchParams.get('success');
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const limit = parseLimit(searchParams.get('limit'));

    const canonicalRows = await listCanonicalToolSpans({
      userId: access.isAdmin ? undefined : access.session.userId,
      limit: 10000,
    });
    if (canonicalRows.length > 0) {
      const logs = canonicalRows
        .map((row) => {
          const metadata =
            row.metadata && typeof row.metadata === 'object'
              ? row.metadata
              : {};
          return {
            id: row.id,
            taskId: row.taskId,
            sessionId: row.sessionId,
            traceId: row.traceId,
            agentId: row.agentId ?? 'unknown',
            toolName:
              typeof metadata.toolName === 'string'
                ? metadata.toolName
                : row.type,
            action:
              typeof metadata.action === 'string' ? metadata.action : 'other',
            target:
              typeof metadata.target === 'string' ? metadata.target : null,
            arguments: row.input,
            result: row.output,
            outputText:
              typeof metadata.outputText === 'string'
                ? metadata.outputText
                : null,
            success: row.status !== 'failed',
            error:
              row.error &&
              typeof row.error === 'object' &&
              'message' in row.error
                ? String((row.error as { message?: unknown }).message ?? '')
                : null,
            durationMs: row.durationMs,
            startedAt: row.startedAt,
            completedAt: row.completedAt,
            createdAt: row.createdAt,
          };
        })
        .filter((log) => {
          if (action && log.action !== action) return false;
          if (toolName && log.toolName !== toolName) return false;
          if (search) {
            const needle = search.toLowerCase();
            if (
              ![log.toolName, log.target, log.outputText, log.error]
                .filter((value): value is string => Boolean(value))
                .some((value) => value.toLowerCase().includes(needle))
            ) {
              return false;
            }
          }
          if (taskId && log.taskId !== taskId) return false;
          if (sessionId && log.sessionId !== sessionId) return false;
          if (agentId && log.agentId !== agentId) return false;
          if (success === 'true' && !log.success) return false;
          if (success === 'false' && log.success) return false;
          if (from && log.createdAt < new Date(from)) return false;
          if (to && log.createdAt > new Date(to)) return false;
          return true;
        })
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
      return NextResponse.json(logs);
    }

    const conditions: SQL[] = [];
    if (action) {
      conditions.push(
        eq(
          agentToolActivityLogs.action,
          action as (typeof agentToolActivityLogs.action.enumValues)[number],
        ),
      );
    }
    if (toolName) {
      conditions.push(eq(agentToolActivityLogs.toolName, toolName));
    }
    if (search) {
      conditions.push(
        or(
          ilike(agentToolActivityLogs.toolName, `%${search}%`),
          ilike(agentToolActivityLogs.target, `%${search}%`),
          ilike(agentToolActivityLogs.outputText, `%${search}%`),
          ilike(agentToolActivityLogs.error, `%${search}%`),
        ) as SQL,
      );
    }
    if (taskId) {
      conditions.push(eq(agentToolActivityLogs.taskId, taskId));
    }
    if (sessionId) {
      conditions.push(eq(agentToolActivityLogs.sessionId, sessionId));
    }
    if (agentId) {
      conditions.push(eq(agentToolActivityLogs.agentId, agentId));
    }
    if (!access.isAdmin) {
      conditions.push(eq(agentToolActivityLogs.userId, access.session.userId));
    }
    if (success === 'true' || success === 'false') {
      conditions.push(eq(agentToolActivityLogs.success, success === 'true'));
    }
    if (from) {
      conditions.push(gte(agentToolActivityLogs.createdAt, new Date(from)));
    }
    if (to) {
      conditions.push(lte(agentToolActivityLogs.createdAt, new Date(to)));
    }

    const logs = await db
      .select()
      .from(agentToolActivityLogs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(agentToolActivityLogs.createdAt))
      .limit(limit);

    return NextResponse.json(logs);
  } catch (error) {
    logger.error('Failed to fetch tool activity logs', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Failed to fetch tool activity logs' },
      { status: 500 },
    );
  }
}
