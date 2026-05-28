import { NextResponse } from 'next/server';
import { db } from '@/lib/core/db';
import { agentReviewLogs } from '@/lib/core/db/schema';
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
      .limit(10000);

    // Convert to CSV
    const csvHeader = 'Timestamp,Level,Decision,Score,Command,Reason,Task ID';
    const csvRows = logs.map((log) => {
      const timestamp = new Date(log.createdAt).toISOString();
      const command = `"${log.command.replace(/"/g, '""')}"`;
      const reason = log.reason ? `"${log.reason.replace(/"/g, '""')}"` : '';
      return `${timestamp},${log.level},${log.decision},${log.score || ''},${command},${reason},${log.taskId}`;
    });

    const csv = [csvHeader, ...csvRows].join('\n');

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="audit-logs-${new Date().toISOString().split('T')[0]}.csv"`,
      },
    });
  } catch (error) {
    console.error('Failed to download audit logs:', error);
    return NextResponse.json(
      { error: 'Failed to download audit logs' },
      { status: 500 }
    );
  }
}
