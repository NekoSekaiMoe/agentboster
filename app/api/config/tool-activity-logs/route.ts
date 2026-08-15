import { requireAuthAccess } from '@/lib/auth/access';
import {
  CANONICAL_QUERY_LIMIT_MAX,
  listCanonicalToolSpans,
} from '@/lib/core/trace/dal';
import { createLogger } from '@/lib/utils/logger';
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

/**
 * Tri-state outcome: terminal `completed` → true, terminal `failed` → false,
 * any non-terminal status (running/pending/…) → null ("unknown").
 */
function outcomeSuccess(status: string): boolean | null {
  if (status === 'completed') return true;
  if (status === 'failed') return false;
  return null;
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

    // listCanonicalToolSpans only pushes userId/limit down (and truncates by
    // startedAt desc), so filters and the sort below align on startedAt too.
    const canonicalRows = await listCanonicalToolSpans({
      userId: access.isAdmin ? undefined : access.session.userId,
      limit: CANONICAL_QUERY_LIMIT_MAX,
    });
    const logs = canonicalRows
      .map((row) => {
        const metadata =
          row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
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
          target: typeof metadata.target === 'string' ? metadata.target : null,
          arguments: row.input,
          result: row.output,
          outputText:
            typeof metadata.outputText === 'string'
              ? metadata.outputText
              : null,
          success: outcomeSuccess(String(row.status)),
          error:
            row.error && typeof row.error === 'object' && 'message' in row.error
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
        // Non-terminal rows (success === null) never match an explicit
        // success=true/false filter — unknown is not "failed".
        if (success === 'true' && log.success !== true) return false;
        if (success === 'false' && log.success !== false) return false;
        if (fromAt && log.startedAt < fromAt) return false;
        if (toAt && log.startedAt > toAt) return false;
        return true;
      })
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit);
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
