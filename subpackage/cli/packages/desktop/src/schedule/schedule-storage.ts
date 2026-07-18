export interface LocalScheduleTask {
  id: string;
  type: 'delay' | 'daily';
  title: string | null;
  prompt: string;
  timezone: string | null;
  dailyTime: string | null;
  nextRunAt: string | null;
  lastTriggeredAt: string | null;
  active: boolean;
  notifyChannel: string | null;
  remoteControl: boolean;
  createdAt: string;
  updatedAt: string;
}

const STORAGE_KEY = 'desktop-schedule-tasks.v1';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeTask(value: unknown): LocalScheduleTask | null {
  const task = asRecord(value);
  if (typeof task.id !== 'string' || task.id.length === 0) return null;
  const type = task.type === 'daily' ? 'daily' : 'delay';
  const title =
    typeof task.title === 'string' && task.title.length > 0
      ? task.title
      : null;
  if (typeof task.prompt !== 'string' || task.prompt.length === 0) return null;
  return {
    id: task.id,
    type,
    title,
    prompt: task.prompt,
    timezone:
      typeof task.timezone === 'string' ? task.timezone : null,
    dailyTime:
      typeof task.dailyTime === 'string' ? task.dailyTime : null,
    nextRunAt:
      typeof task.nextRunAt === 'string' ? task.nextRunAt : null,
    lastTriggeredAt:
      typeof task.lastTriggeredAt === 'string'
        ? task.lastTriggeredAt
        : null,
    active: task.active !== false,
    notifyChannel:
      typeof task.notifyChannel === 'string' ? task.notifyChannel : null,
    remoteControl: task.remoteControl === true,
    createdAt:
      typeof task.createdAt === 'string' ? task.createdAt : new Date().toISOString(),
    updatedAt:
      typeof task.updatedAt === 'string' ? task.updatedAt : new Date().toISOString(),
  };
}

export function loadLocalScheduleTasks(): LocalScheduleTask[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => normalizeTask(entry))
      .filter((entry): entry is LocalScheduleTask => Boolean(entry));
  } catch {
    return [];
  }
}

export function saveLocalScheduleTasks(
  tasks: LocalScheduleTask[],
): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch {
    // ignore quota / serialization errors
  }
}

export function upsertLocalScheduleTask(
  task: LocalScheduleTask,
): LocalScheduleTask[] {
  const tasks = loadLocalScheduleTasks();
  const index = tasks.findIndex((entry) => entry.id === task.id);
  if (index >= 0) {
    tasks[index] = task;
  } else {
    tasks.push(task);
  }
  saveLocalScheduleTasks(tasks);
  return tasks;
}

export function deleteLocalScheduleTask(
  id: string,
): LocalScheduleTask[] {
  const tasks = loadLocalScheduleTasks().filter((entry) => entry.id !== id);
  saveLocalScheduleTasks(tasks);
  return tasks;
}
