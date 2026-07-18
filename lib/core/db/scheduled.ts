import { db, schema } from '@/lib/core/db';
import { createLogger } from '@/lib/utils/logger';
import { and, eq, inArray } from 'drizzle-orm';

const logger = createLogger('db.scheduled');

export type ScheduledTaskType = 'delay' | 'daily';

type ScheduledTaskMetadata = Record<string, unknown> | undefined;

export async function createScheduledTask(input: {
  sessionId: string;
  type: ScheduledTaskType;
  title?: string;
  prompt: string;
  timezone?: string;
  dailyTime?: string;
  nextRunAt?: Date | null;
  metadata?: ScheduledTaskMetadata;
  notifyChannel?: string | null;
  remoteControl?: boolean;
  preferredNodeId?: string | null;
  allowedNodes?: string[] | null;
  autoFallbackNode?: boolean;
}) {
  logger.info('create:start', {
    sessionId: input.sessionId,
    type: input.type,
  });

  const [task] = await db
    .insert(schema.scheduledTasks)
    .values({
      sessionId: input.sessionId,
      type: input.type,
      title: input.title ?? null,
      prompt: input.prompt,
      timezone: input.timezone ?? null,
      dailyTime: input.dailyTime ?? null,
      nextRunAt: input.nextRunAt ?? null,
      metadata: input.metadata ?? null,
      notifyChannel: input.notifyChannel ?? null,
      remoteControl: input.remoteControl ?? false,
      preferredNodeId: input.preferredNodeId ?? null,
      allowedNodes: input.allowedNodes ?? null,
      autoFallbackNode: input.autoFallbackNode ?? false,
    })
    .returning();

  if (!task) {
    throw new Error('Failed to create scheduled task.');
  }

  logger.info('create:success', { taskId: task.id });
  return task;
}

export async function getScheduledTask(
  taskId: string,
  options?: { userId?: string },
) {
  const conditions: ReturnType<typeof eq>[] = [
    eq(schema.scheduledTasks.id, taskId),
  ];

  if (options?.userId) {
    const userSessionIds = db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, options.userId));

    conditions.push(inArray(schema.scheduledTasks.sessionId, userSessionIds));
  }

  const [task] = await db
    .select()
    .from(schema.scheduledTasks)
    .where(and(...conditions))
    .limit(1);

  return task ?? null;
}

export async function listScheduledTasks(options?: { userId?: string }) {
  const conditions: ReturnType<typeof eq>[] = [];

  if (options?.userId) {
    const userSessionIds = db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, options.userId));

    conditions.push(inArray(schema.scheduledTasks.sessionId, userSessionIds));
  }

  const tasks = await db
    .select()
    .from(schema.scheduledTasks)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  return tasks.sort((left, right) => {
    if (left.active !== right.active) {
      return left.active ? -1 : 1;
    }

    const leftNext = left.nextRunAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const rightNext = right.nextRunAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (leftNext !== rightNext) {
      return leftNext - rightNext;
    }

    return right.createdAt.getTime() - left.createdAt.getTime();
  });
}

export async function listScheduledTasksBySessionId(
  sessionId: string,
  options?: { userId?: string },
) {
  const conditions: ReturnType<typeof eq>[] = [
    eq(schema.scheduledTasks.sessionId, sessionId),
  ];

  if (options?.userId) {
    const userSessionIds = db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, options.userId));

    conditions.push(inArray(schema.scheduledTasks.sessionId, userSessionIds));
  }

  return db
    .select()
    .from(schema.scheduledTasks)
    .where(and(...conditions));
}

export async function updateScheduledTask(
  taskId: string,
  input: {
    type?: ScheduledTaskType;
    title?: string | null;
    prompt?: string;
    timezone?: string | null;
    dailyTime?: string | null;
    nextRunAt?: Date | null;
    lastTriggeredAt?: Date | null;
    lastFiredFor?: Date | null;
    scheduleWorkflowRunId?: string | null;
    lastChatRunId?: string | null;
    active?: boolean;
    metadata?: ScheduledTaskMetadata | null;
    notifyChannel?: string | null;
    remoteControl?: boolean;
    preferredNodeId?: string | null;
    allowedNodes?: string[] | null;
    autoFallbackNode?: boolean;
    failureCount?: number;
    disabledByFailure?: boolean;
  },
  options?: { userId?: string },
) {
  logger.log('update:start', { taskId, keys: Object.keys(input) });

  const conditions: ReturnType<typeof eq>[] = [
    eq(schema.scheduledTasks.id, taskId),
  ];

  if (options?.userId) {
    const userSessionIds = db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, options.userId));

    conditions.push(inArray(schema.scheduledTasks.sessionId, userSessionIds));
  }

  await db
    .update(schema.scheduledTasks)
    .set({
      ...input,
      updatedAt: new Date(),
    })
    .where(and(...conditions));

  logger.log('update:success', { taskId });
}

export async function deleteScheduledTask(
  taskId: string,
  options?: { userId?: string },
) {
  logger.info('delete:start', { taskId });

  const conditions: ReturnType<typeof eq>[] = [
    eq(schema.scheduledTasks.id, taskId),
  ];

  if (options?.userId) {
    const userSessionIds = db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, options.userId));

    conditions.push(inArray(schema.scheduledTasks.sessionId, userSessionIds));
  }

  const [task] = await db
    .delete(schema.scheduledTasks)
    .where(and(...conditions))
    .returning();

  logger.info('delete:success', { taskId });
  return task ?? null;
}
