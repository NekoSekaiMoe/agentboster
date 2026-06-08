import { readAuthSessionFromCookies } from '@/lib/auth';
import { db } from '@/lib/core/db';
import { agentToolActivityLogs } from '@/lib/core/db/schema';
import { type SQL, and, desc, eq, gte, ilike, lte, or } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

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
    const session = await readAuthSessionFromCookies(cookieStore);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

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
    console.error('Failed to fetch tool activity logs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch tool activity logs' },
      { status: 500 },
    );
  }
}
