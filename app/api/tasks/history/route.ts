import { db } from '@/lib/core/db';
import { agentTasks } from '@/lib/core/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const agentId = searchParams.get('agentId');

    const conditions = [];
    if (status) {
      conditions.push(
        eq(
          agentTasks.status,
          status as 'pending' | 'running' | 'completed' | 'failed',
        ),
      );
    }
    if (agentId) {
      conditions.push(eq(agentTasks.agentId, agentId));
    }

    const tasks = await db
      .select({
        id: agentTasks.id,
        sessionId: agentTasks.sessionId,
        agentId: agentTasks.agentId,
        command: agentTasks.command,
        status: agentTasks.status,
        createdAt: agentTasks.createdAt,
        completedAt: agentTasks.updatedAt,
      })
      .from(agentTasks)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(agentTasks.createdAt))
      .limit(1000);

    // Calculate duration for completed tasks
    const tasksWithDuration = tasks.map((task) => {
      let duration = null;
      if (task.status === 'completed' && task.completedAt && task.createdAt) {
        duration = Math.floor(
          (new Date(task.completedAt).getTime() -
            new Date(task.createdAt).getTime()) /
            1000,
        );
      }
      return {
        ...task,
        duration,
      };
    });

    return NextResponse.json(tasksWithDuration);
  } catch (error) {
    console.error('Failed to fetch tasks:', error);
    return NextResponse.json(
      { error: 'Failed to fetch tasks' },
      { status: 500 },
    );
  }
}
