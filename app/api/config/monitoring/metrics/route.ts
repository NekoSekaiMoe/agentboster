import { readAuthSessionFromCookies } from '@/lib/auth';
import { db } from '@/lib/core/db';
import { agentSandboxes, agentTasks } from '@/lib/core/db/schema';
import { count, eq } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const cookieStore = await cookies();
    const session = await readAuthSessionFromCookies(cookieStore);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    // Get active sandboxes count
    const activeSandboxesResult = await db
      .select({ count: count() })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.status, 'ready'));
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
      { status: 500 },
    );
  }
}
