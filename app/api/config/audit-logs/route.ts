import { requireAuthAccess } from '@/lib/auth/access';
import { db } from '@/lib/core/db';
import { agentReviewLogs, agentTasks } from '@/lib/core/db/schema';
import { type SQL, and, desc, eq, gte, ilike, lte } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

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

    const conditions: SQL[] = [];
    if (level) {
      conditions.push(eq(agentReviewLogs.level, level as 'L0' | 'L1' | 'L2'));
    }
    if (decision) {
      conditions.push(
        eq(
          agentReviewLogs.decision,
          decision as (typeof agentReviewLogs.decision.enumValues)[number],
        ),
      );
    }
    if (search) {
      conditions.push(ilike(agentReviewLogs.command, `%${search}%`));
    }
    if (taskId) {
      conditions.push(eq(agentReviewLogs.taskId, taskId));
    }
    if (agentId) {
      conditions.push(eq(agentTasks.agentId, agentId));
    }
    if (!access.isAdmin) {
      conditions.push(eq(agentReviewLogs.userId, access.session.userId));
    }
    if (from) {
      conditions.push(gte(agentReviewLogs.createdAt, new Date(from)));
    }
    if (to) {
      conditions.push(lte(agentReviewLogs.createdAt, new Date(to)));
    }

    const logs = await db
      .select({
        id: agentReviewLogs.id,
        taskId: agentReviewLogs.taskId,
        traceId: agentReviewLogs.traceId,
        userId: agentReviewLogs.userId,
        roles: agentReviewLogs.roles,
        command: agentReviewLogs.command,
        level: agentReviewLogs.level,
        score: agentReviewLogs.score,
        decision: agentReviewLogs.decision,
        reason: agentReviewLogs.reason,
        createdAt: agentReviewLogs.createdAt,
        agentId: agentTasks.agentId,
        sessionId: agentTasks.sessionId,
      })
      .from(agentReviewLogs)
      .leftJoin(agentTasks, eq(agentReviewLogs.taskId, agentTasks.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(agentReviewLogs.createdAt))
      .limit(1000);

    return NextResponse.json(logs);
  } catch (error) {
    console.error('Failed to fetch audit logs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch audit logs' },
      { status: 500 },
    );
  }
}
