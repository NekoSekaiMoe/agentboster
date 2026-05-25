'use server';

import { readAuthSessionFromCookies } from '@/lib/auth';
import {
  type ScheduledTaskType,
  deleteScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  updateScheduledTask,
} from '@/lib/core/db/scheduled';
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

type PersistedScheduledTask = Awaited<
  ReturnType<typeof listScheduledTasks>
>[number];

export type DisplayStatus = 'scheduled' | 'archived';

export type ScheduleTaskRecord = {
  id: string;
  sessionId: string;
  type: ScheduledTaskType;
  title: string | null;
  prompt: string;
  timezone: string | null;
  dailyTime: string | null;
  nextRunAt: string | null;
  lastTriggeredAt: string | null;
  lastFiredFor: string | null;
  scheduleWorkflowRunId: string | null;
  lastChatRunId: string | null;
  active: boolean;
  archived: boolean;
  displayStatus: DisplayStatus;
  createdAt: string;
  updatedAt: string;
};

export type UpdateScheduleTaskInput = z.infer<typeof updateTaskSchema>;

async function requireAuth() {
  const cookieStore = await cookies();
  const authSession = await readAuthSessionFromCookies(cookieStore);

  if (!authSession) {
    throw new Error('Unauthorized');
  }

  return authSession;
}

function deriveDisplayStatus(task: PersistedScheduledTask) {
  const now = Date.now();
  const archived =
    task.type === 'delay' &&
    (task.lastTriggeredAt !== null ||
      (!task.active && task.nextRunAt === null) ||
      (task.nextRunAt !== null && task.nextRunAt.getTime() <= now));

  return {
    ...task,
    archived,
    displayStatus: archived ? ('archived' as const) : ('scheduled' as const),
  };
}

function serializeTask(task: PersistedScheduledTask): ScheduleTaskRecord {
  const withStatus = deriveDisplayStatus(task);

  return {
    id: withStatus.id,
    sessionId: withStatus.sessionId,
    type: withStatus.type,
    title: withStatus.title,
    prompt: withStatus.prompt,
    timezone: withStatus.timezone,
    dailyTime: withStatus.dailyTime,
    nextRunAt: withStatus.nextRunAt?.toISOString() ?? null,
    lastTriggeredAt: withStatus.lastTriggeredAt?.toISOString() ?? null,
    lastFiredFor: withStatus.lastFiredFor?.toISOString() ?? null,
    scheduleWorkflowRunId: withStatus.scheduleWorkflowRunId,
    lastChatRunId: withStatus.lastChatRunId,
    active: withStatus.active,
    archived: withStatus.archived,
    displayStatus: withStatus.displayStatus,
    createdAt: withStatus.createdAt.toISOString(),
    updatedAt: withStatus.updatedAt.toISOString(),
  };
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
  await requireAuth();

  const tasks = await listScheduledTasks();
  return {
    tasks: tasks.map(serializeTask),
  };
}

export async function updateScheduleTaskAction(input: {
  id: string;
  task: UpdateScheduleTaskInput;
}) {
  await requireAuth();

  const taskId = input.id.trim();
  if (!taskId) {
    throw new Error('Task id is required');
  }

  const existing = await getScheduledTask(taskId);
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

  await updateScheduledTask(taskId, {
    type: normalized.type,
    title: task.title ?? null,
    prompt: task.prompt,
    timezone: normalized.timezone,
    dailyTime: normalized.dailyTime,
    nextRunAt: normalized.nextRunAt,
    active: task.active,
    metadata: normalized.metadata,
    scheduleWorkflowRunId: null,
  });

  if (task.active) {
    const run = await start(scheduledTaskWorkflow, [taskId]);
    await updateScheduledTask(taskId, {
      scheduleWorkflowRunId: run.runId,
    });
  }

  return { ok: true as const };
}

export async function deleteScheduleTaskAction(taskId: string) {
  await requireAuth();

  const id = taskId.trim();
  if (!id) {
    throw new Error('Task id is required');
  }

  const existing = await getScheduledTask(id);
  if (!existing) {
    throw new Error('Task not found');
  }

  await cancelScheduleRun(existing.scheduleWorkflowRunId);
  await deleteScheduledTask(id);

  return { ok: true as const };
}
