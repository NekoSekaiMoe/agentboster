import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { agentReviewLogs } from '@/lib/db/schema';
import { desc, eq, ilike, and } from 'drizzle-orm';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const level = searchParams.get('level');
    const decision = searchParams.get('decision');
    const search = searchParams.get('search');

    const conditions = [];
    if (level) {
      conditions.push(eq(agentReviewLogs.level, level as 'L0' | 'L1' | 'L2'));
    }
    if (decision) {
      conditions.push(
        eq(agentReviewLogs.decision, decision as 'allowed' | 'blocked' | 'pending_confirm')
      );
    }
    if (search) {
      conditions.push(ilike(agentReviewLogs.command, `%${search}%`));
    }

    const logs = await db
      .select({
        id: agentReviewLogs.id,
        taskId: agentReviewLogs.taskId,
        command: agentReviewLogs.command,
        level: agentReviewLogs.level,
        score: agentReviewLogs.score,
        decision: agentReviewLogs.decision,
        reason: agentReviewLogs.reason,
        createdAt: agentReviewLogs.createdAt,
      })
      .from(agentReviewLogs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(agentReviewLogs.createdAt))
      .limit(1000);

    return NextResponse.json(logs);
  } catch (error) {
    console.error('Failed to fetch audit logs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch audit logs' },
      { status: 500 }
    );
  }
}
