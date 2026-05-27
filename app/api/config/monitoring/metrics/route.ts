import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { agentTasks, agentSandboxes } from '@/lib/db/schema';
import { count, eq } from 'drizzle-orm';

export async function GET() {
  try {
    // Get active sandboxes count
    const activeSandboxesResult = await db
      .select({ count: count() })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.status, 'active'));
    const activeSandboxes = activeSandboxesResult[0]?.count || 0;

    // Get active tasks count
    const activeTasksResult = await db
      .select({ count: count() })
      .from(agentTasks)
      .where(eq(agentTasks.status, 'running'));
    const activeTasks = activeTasksResult[0]?.count || 0;

    // Get total tasks count
    const totalTasksResult = await db
      .select({ count: count() })
      .from(agentTasks);
    const totalTasks = totalTasksResult[0]?.count || 0;

    // Get completed tasks count
    const completedTasksResult = await db
      .select({ count: count() })
      .from(agentTasks)
      .where(eq(agentTasks.status, 'completed'));
    const completedTasks = completedTasksResult[0]?.count || 0;

    // Get failed tasks count
    const failedTasksResult = await db
      .select({ count: count() })
      .from(agentTasks)
      .where(eq(agentTasks.status, 'failed'));
    const failedTasks = failedTasksResult[0]?.count || 0;

    return NextResponse.json({
      activeSandboxes,
      activeTasks,
      totalTasks,
      completedTasks,
      failedTasks,
    });
  } catch (error) {
    console.error('Failed to fetch metrics:', error);
    return NextResponse.json(
      { error: 'Failed to fetch metrics' },
      { status: 500 }
    );
  }
}
