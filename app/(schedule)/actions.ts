'use server';

import { readAuthSessionFromCookies } from '@/lib/auth';
import {
  deleteScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  updateScheduledTask,
} from '@/lib/core/db/scheduled';
import {
  serializeScheduledTask,
  type PersistedScheduledTask,
  type ScheduleTaskRecord,
} from '@/lib/cli/schedule-serialization';
import { createLogger } from '@/lib/utils/logger';
import { scheduledTaskWorkflow } from '@/lib/workflow/scheduled';
import {
  computeNextDailyRunAt,
  getDefaultScheduleTimezone,
  parseDelayTarget,
  validateTimezone,
} from '@/lib/workflow/scheduled/utils';
import { cookies } from 'next/headers';
import { getRun, start } from 'workflow/api';
import { z } from 'zod';

const logger = createLogger('actions.schedules');

const baseTaskSchema = z.object({
  title: z.string().trim().min(1).nullable().optional(),
  prompt: z.string().trim().min(1),
  active: z.boolean().default(true),
});

const delayTaskSchema = baseTaskSchema.extend({
  type: z.literal('delay'),
  runAt: z.iso.datetime(),
});

const dailyTaskSchema = baseTaskSchema.extend({
  type: z.literal('daily'),
  dailyTime: z.string().trim().min(1),
  timezone: z.string().trim().min(1).optional(),
});

const updateTaskSchema = z.discriminatedUnion('type', [
  delayTaskSchema,
  dailyTaskSchema,
]);

export type { PersistedScheduledTask, ScheduleTaskRecord };

export type DisplayStatus = 'scheduled' | 'archived';

export type UpdateScheduleTaskInput = z.infer<typeof updateTaskSchema>;

async function requireAuth() {
  const cookieStore = await cookies();
  const authSession = await readAuthSessionFromCookies(cookieStore);

  if (!authSession) {
    throw new Error('Unauthorized');
  }

  return authSession;
}

function serializeTask(task: PersistedScheduledTask): ScheduleTaskRecord {
  return serializeScheduledTask(task);
}

async function cancelScheduleRun(runId: string | null | undefined) {
  if (!runId) {
    return;
  }

  try {
    await getRun(runId).cancel();
  } catch (error) {
    logger.warn('schedule:cancel_run_failed', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function listScheduleTasksAction() {
  const authSession = await requireAuth();

  const tasks = await listScheduledTasks({ userId: authSession.userId });
  return {
    tasks: tasks.map(serializeTask),
  };
}

export async function updateScheduleTaskAction(input: {
  id: string;
  task: UpdateScheduleTaskInput;
}) {
  const authSession = await requireAuth();

  const taskId = input.id.trim();
  if (!taskId) {
    throw new Error('Task id is required');
  }

  const existing = await getScheduledTask(taskId, {
    userId: authSession.userId,
  });
  if (!existing) {
    throw new Error('Task not found');
  }

  const parsed = updateTaskSchema.safeParse(input.task);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues[0]?.message ?? 'Invalid schedule task payload',
    );
  }

  const task = parsed.data;
  const now = new Date();
  const normalized =
    task.type === 'delay'
      ? {
          type: 'delay' as const,
          timezone: null,
          dailyTime: null,
          nextRunAt: parseDelayTarget({
            runAt: task.runAt,
            now,
          }),
          metadata: {
            runAt: task.runAt,
          },
        }
      : {
          type: 'daily' as const,
          timezone: validateTimezone(
            task.timezone ?? getDefaultScheduleTimezone(),
          ),
          dailyTime: task.dailyTime,
          nextRunAt: computeNextDailyRunAt({
            dailyTime: task.dailyTime,
            timeZone: task.timezone ?? getDefaultScheduleTimezone(),
            now,
          }),
          metadata: {
            timezone: task.timezone ?? getDefaultScheduleTimezone(),
            dailyTime: task.dailyTime,
          },
        };

  await cancelScheduleRun(existing.scheduleWorkflowRunId);

  await updateScheduledTask(
    taskId,
    {
      type: normalized.type,
      title: task.title ?? null,
      prompt: task.prompt,
      timezone: normalized.timezone,
      dailyTime: normalized.dailyTime,
      nextRunAt: normalized.nextRunAt,
      active: task.active,
      metadata: normalized.metadata,
      scheduleWorkflowRunId: null,
    },
    { userId: authSession.userId },
  );

  if (task.active) {
    const run = await start(scheduledTaskWorkflow, [taskId]);
    await updateScheduledTask(
      taskId,
      {
        scheduleWorkflowRunId: run.runId,
      },
      { userId: authSession.userId },
    );
  }

  return { ok: true as const };
}

export async function deleteScheduleTaskAction(taskId: string) {
  const authSession = await requireAuth();

  const id = taskId.trim();
  if (!id) {
    throw new Error('Task id is required');
  }

  const existing = await getScheduledTask(id, { userId: authSession.userId });
  if (!existing) {
    throw new Error('Task not found');
  }

  await cancelScheduleRun(existing.scheduleWorkflowRunId);
  await deleteScheduledTask(id, { userId: authSession.userId });

  return { ok: true as const };
}
