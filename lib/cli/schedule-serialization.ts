import {
  type ScheduledTaskType,
  listScheduledTasks,
} from '@/lib/core/db/scheduled';

export type PersistedScheduledTask = Awaited<
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
  notifyChannel: string | null;
  remoteControl: boolean;
  // Node-routing preferences (Web tasks only; ignored for remoteControl).
  preferredNodeId: string | null;
  allowedNodes: string[] | null;
  autoFallbackNode: boolean;
  // Failure tracking. failureCount is consecutive failures (cleared on
  // any success); disabledByFailure is true when the task was auto-
  // disabled by the dispatch path, distinguishing it from a user
  // manually setting active=false.
  failureCount: number;
  disabledByFailure: boolean;
  createdAt: string;
  updatedAt: string;
};

export function deriveDisplayStatus(task: PersistedScheduledTask) {
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

export function serializeScheduledTask(
  task: PersistedScheduledTask,
): ScheduleTaskRecord {
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
    notifyChannel: withStatus.notifyChannel,
    remoteControl: withStatus.remoteControl ?? false,
    preferredNodeId: withStatus.preferredNodeId ?? null,
    allowedNodes: withStatus.allowedNodes ?? null,
    autoFallbackNode: withStatus.autoFallbackNode ?? false,
    failureCount: withStatus.failureCount ?? 0,
    disabledByFailure: withStatus.disabledByFailure ?? false,
    createdAt: withStatus.createdAt.toISOString(),
    updatedAt: withStatus.updatedAt.toISOString(),
  };
}
