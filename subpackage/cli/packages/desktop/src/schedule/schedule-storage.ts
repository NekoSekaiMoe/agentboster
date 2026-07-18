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
  // Consecutive-failure tracking, mirroring the Web-task schema. The
  // local scheduler increments this on every failed fire (CLI offline,
  // trigger callback error, etc.) and resets to 0 on success. After
  // MAX_LOCAL_SCHEDULE_FAILURES (3) ticks the task is auto-disabled
  // (`active=false`, `disabledByFailure=true`). Re-enabling via the UI
  // clears both fields.
  failureCount: number;
  disabledByFailure: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Error thrown when persisting schedule tasks fails (quota exceeded,
 * serialization error, storage disabled in privacy modes, etc.).
 * Callers should surface this to the user instead of pretending the
 * write succeeded.
 */
export class ScheduleStorageError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'ScheduleStorageError';
    this.cause = cause;
  }
}

const STORAGE_KEY = 'desktop-schedule-tasks.v1';

/**
 * Sentinel timestamp used when a persisted task is missing createdAt /
 * updatedAt (legacy data from before those fields were required).
 *
 * Why not `new Date().toISOString()`: the scheduler's
 * `mergeFiredResults` uses `preFire.updatedAt !== task.updatedAt` to
 * detect concurrent edits during a fire. If `load()` synthesized a
 * fresh `now` timestamp on every call, the snapshot taken before
 * firing and the snapshot re-read for merge would never match, and
 * fired results would be silently dropped — re-dispatching the task
 * every 30s forever. This sentinel is stable across calls so the
 * comparison works; `load()` also eagerly migrates any task that
 * still has the sentinel by writing the migrated form back to disk,
 * so subsequent loads see a real timestamp.
 */
const MISSING_TIMESTAMP = new Date(0).toISOString();

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
    typeof task.title === 'string' && task.title.length > 0 ? task.title : null;
  if (typeof task.prompt !== 'string' || task.prompt.length === 0) return null;
  return {
    id: task.id,
    type,
    title,
    prompt: task.prompt,
    timezone: typeof task.timezone === 'string' ? task.timezone : null,
    dailyTime: typeof task.dailyTime === 'string' ? task.dailyTime : null,
    nextRunAt: typeof task.nextRunAt === 'string' ? task.nextRunAt : null,
    lastTriggeredAt:
      typeof task.lastTriggeredAt === 'string' ? task.lastTriggeredAt : null,
    active: task.active !== false,
    notifyChannel:
      typeof task.notifyChannel === 'string' ? task.notifyChannel : null,
    remoteControl: task.remoteControl === true,
    failureCount:
      typeof task.failureCount === 'number' && task.failureCount >= 0
        ? task.failureCount
        : 0,
    disabledByFailure: task.disabledByFailure === true,
    createdAt:
      typeof task.createdAt === 'string' ? task.createdAt : MISSING_TIMESTAMP,
    updatedAt:
      typeof task.updatedAt === 'string' ? task.updatedAt : MISSING_TIMESTAMP,
  };
}

export function loadLocalScheduleTasks(): LocalScheduleTask[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const tasks = parsed
      .map((entry) => normalizeTask(entry))
      .filter((entry): entry is LocalScheduleTask => Boolean(entry));

    // Eager migration: if any task still carries the sentinel timestamp
    // (i.e. it was missing from disk), persist a real timestamp NOW so
    // the next `load()` returns a stable value. Without this, two
    // consecutive `load()` calls in the same tick would each synthesize
    // a different `new Date().toISOString()` fallback and break the
    // scheduler's edit-detection. Best-effort: if the write fails (e.g.
    // quota), we still return the in-memory tasks — callers can keep
    // working, and the next successful write will migrate them.
    if (tasks.some((t) => t.updatedAt === MISSING_TIMESTAMP)) {
      const migrateAt = new Date().toISOString();
      for (const t of tasks) {
        if (t.createdAt === MISSING_TIMESTAMP) t.createdAt = migrateAt;
        if (t.updatedAt === MISSING_TIMESTAMP) t.updatedAt = migrateAt;
      }
      try {
        saveLocalScheduleTasks(tasks);
      } catch {
        // Migration failed — non-fatal, see comment above.
      }
    }

    return tasks;
  } catch {
    return [];
  }
}

export function saveLocalScheduleTasks(tasks: LocalScheduleTask[]): void {
  // Surface persistence failures to the caller. Quota-exceeded, private
  // mode storage being unavailable, and serialization errors all need
  // to be reported — otherwise the UI shows "saved" while nothing was
  // actually written, and the user loses the task on next reload.
  let serialized: string;
  try {
    serialized = JSON.stringify(tasks);
  } catch (err) {
    throw new ScheduleStorageError(
      'Failed to serialize schedule tasks for storage.',
      err,
    );
  }
  try {
    localStorage.setItem(STORAGE_KEY, serialized);
  } catch (err) {
    throw new ScheduleStorageError(
      'Failed to persist schedule tasks to local storage (quota or access denied).',
      err,
    );
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

export function deleteLocalScheduleTask(id: string): LocalScheduleTask[] {
  const tasks = loadLocalScheduleTasks().filter((entry) => entry.id !== id);
  saveLocalScheduleTasks(tasks);
  return tasks;
}
