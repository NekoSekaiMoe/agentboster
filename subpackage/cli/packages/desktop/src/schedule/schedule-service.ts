import {
  loadLocalScheduleTasks,
  saveLocalScheduleTasks,
  type LocalScheduleTask,
} from './schedule-storage.js';

export type ScheduleFireStatus = 'completed' | 'failed';

export interface ScheduleFireResult {
  status: ScheduleFireStatus;
  error?: string;
}

export type ScheduleTriggerCallback = (
  task: LocalScheduleTask,
) => Promise<{ ok: boolean; error?: string }>;

export type ScheduleNotificationCallback = (
  task: LocalScheduleTask,
  result: ScheduleFireResult,
) => void;

const TICK_INTERVAL_MS = 30_000;

/**
 * Consecutive failure threshold for auto-disabling local schedule
 * tasks. Mirrors the Web-task constant
 * `MAX_SCHEDULE_FAILURES` in `lib/workflow/scheduled/dispatch.ts`.
 */
const MAX_LOCAL_SCHEDULE_FAILURES = 3;

/**
 * Compute the next daily fire instant from a task's wall-clock dailyTime
 * in its own timezone. Adding a fixed 24h offset (the previous
 * implementation) drifts by an hour across DST transitions and ignores
 * the user's timezone entirely.
 *
 * We walk forward day-by-day (max ~3 days to find a future instant),
 * reconstruct the wall-clock `hour:minute` in the target timezone, and
 * convert to an absolute instant using the same algorithm as
 * `datetimeLocalToIso` in schedule-view.ts. Falls back to +24h when the
 * timezone is missing/invalid to preserve past behavior.
 */
function computeNextDailyInstant(
  currentRunAt: Date,
  dailyTime: string | null,
  timezone: string | null,
): Date {
  if (!dailyTime || !timezone) {
    return new Date(currentRunAt.getTime() + 24 * 60 * 60 * 1000);
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(dailyTime.trim());
  if (!match) {
    return new Date(currentRunAt.getTime() + 24 * 60 * 60 * 1000);
  }
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return new Date(currentRunAt.getTime() + 24 * 60 * 60 * 1000);
  }

  for (let offsetDays = 1; offsetDays <= 3; offsetDays++) {
    const base = new Date(currentRunAt);
    base.setUTCDate(base.getUTCDate() + offsetDays);
    const year = base.getUTCFullYear();
    const month = base.getUTCMonth();
    const day = base.getUTCDate();
    const pad = (n: number) => String(n).padStart(2, '0');
    const wallLocal = `${year}-${pad(month + 1)}-${pad(day)}T${pad(hour)}:${pad(
      minute,
    )}`;
    const iso = wallClockToIso(wallLocal, timezone);
    if (!iso) continue;
    const instant = new Date(iso);
    if (instant.getTime() > Date.now()) {
      return instant;
    }
  }
  return new Date(currentRunAt.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Convert a wall-clock string `YYYY-MM-DDTHH:mm` interpreted in `timezone`
 * to an ISO instant. Mirrors the algorithm in schedule-view.ts' datetimeLocalToIso
 * (kept local to avoid pulling UI code into the service module).
 */
function wallClockToIso(wallLocal: string, timezone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wallLocal.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const year = Number.parseInt(y, 10);
  const month = Number.parseInt(mo, 10);
  const day = Number.parseInt(d, 10);
  const hour = Number.parseInt(h, 10);
  const minute = Number.parseInt(mi, 10);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return null;
  }
  const wallUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = formatter.formatToParts(new Date(wallUtc));
    const get = (type: string): number => {
      const v = parts.find((p) => p.type === type)?.value ?? '';
      return Number.parseInt(v, 10);
    };
    const zHour = get('hour') === 24 ? 0 : get('hour');
    const wallInZone = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      zHour,
      get('minute'),
      get('second'),
      0,
    );
    const offsetMs = wallInZone - wallUtc;
    return new Date(wallUtc - offsetMs).toISOString();
  } catch {
    const localDate = new Date(year, month - 1, day, hour, minute, 0, 0);
    return localDate.toISOString();
  }
}

export class ScheduleService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private triggerCallback: ScheduleTriggerCallback | null = null;
  private notificationCallback: ScheduleNotificationCallback | null = null;
  // Snapshot of tasks captured at the start of each tick(), used by
  // mergeFiredResults to detect concurrent edits during the fire await.
  // Reset to null when a tick completes.
  private preFireSnapshot: Map<string, LocalScheduleTask> | null = null;

  setTriggerCallback(cb: ScheduleTriggerCallback): void {
    this.triggerCallback = cb;
  }

  setNotificationCallback(cb: ScheduleNotificationCallback): void {
    this.notificationCallback = cb;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // Snapshot the tasks we intend to fire BEFORE awaiting the external
      // trigger. The await can take a long time, during which the user
      // may edit or delete tasks in the UI; those writes go to the same
      // localStorage key, so we cannot simply write our stale snapshot
      // back afterward — we must merge per-task.
      const initialSnapshot = loadLocalScheduleTasks();
      this.preFireSnapshot = new Map(
        initialSnapshot.map((t) => [t.id, t] as const),
      );
      const now = Date.now();
      const fired: Array<{
        id: string;
        nextRunAt: string | null;
        result: ScheduleFireResult;
      }> = [];

      for (const task of initialSnapshot) {
        if (!task.active) continue;
        if (!task.nextRunAt) continue;
        const runAt = new Date(task.nextRunAt);
        if (!Number.isFinite(runAt.getTime())) continue;
        if (runAt.getTime() > now) continue;

        const result = await this.fire(task);
        const triggeredAt = new Date().toISOString();
        const nextRunAt =
          task.type === 'delay'
            ? null
            : computeNextDailyInstant(
                runAt,
                task.dailyTime,
                task.timezone,
              ).toISOString();
        fired.push({ id: task.id, nextRunAt, result });

        // Fire the notification callback BEFORE persisting — but isolate
        // exceptions so a buggy callback cannot block the save. Without
        // isolation, a throw here would skip saveLocalScheduleTasks()
        // entirely and the task would re-fire on the next tick.
        if (this.notificationCallback) {
          try {
            const mutated: LocalScheduleTask = {
              ...task,
              lastTriggeredAt: triggeredAt,
              active: task.type === 'delay' ? false : task.active,
              nextRunAt,
              updatedAt: triggeredAt,
            };
            this.notificationCallback(mutated, result);
          } catch (callbackError) {
            // Swallow but log via console — the service has no logger
            // dependency and shouldn't introduce one for this edge case.
            console.warn(
              '[schedule] notification callback threw — task state will still be persisted',
              callbackError,
            );
          }
        }
      }

      if (fired.length > 0) {
        this.mergeFiredResults(fired);
      }
    } finally {
      this.ticking = false;
      this.preFireSnapshot = null;
    }
  }

  /**
   * Re-read the latest tasks from storage and merge the fired results in.
   * Tasks that were deleted or modified (by updatedAt) during the fire
   * await are left untouched. Only still-present, unmodified tasks get
   * their trigger-time / active / nextRunAt / updatedAt fields updated.
   */
  private mergeFiredResults(
    fired: Array<{
      id: string;
      nextRunAt: string | null;
      result: ScheduleFireResult;
    }>,
  ): void {
    if (!this.preFireSnapshot) return;
    const latest = loadLocalScheduleTasks();
    const preFireSnapshot = this.preFireSnapshot;
    const updatesByTaskId = new Map(fired.map((f) => [f.id, f] as const));
    const triggeredAt = new Date().toISOString();
    let mutated = false;

    const merged: LocalScheduleTask[] = latest.map((task) => {
      const update = updatesByTaskId.get(task.id);
      if (!update) return task;
      const preFire = preFireSnapshot.get(task.id);
      // If the task was edited or replaced while we were firing (its
      // updatedAt differs from what we snapshotted), skip the merge so
      // we don't clobber the user's edit. Deleted tasks won't appear in
      // `latest` at all, so they're naturally skipped.
      if (preFire && preFire.updatedAt !== task.updatedAt) {
        return task;
      }
      mutated = true;
      const isDelay = task.type === 'delay';
      const succeeded = update.result.status === 'completed';

      // Failure accounting mirrors the Web-task schema:
      //  - success clears failureCount + disabledByFailure
      //  - failure increments failureCount; when it reaches the
      //    threshold the task is auto-disabled (active=false,
      //    disabledByFailure=true) so it stops firing until the user
      //    re-enables it. Delay tasks that failed are a special case:
      //    they were going to be disabled anyway (isDelay → active=
      //    false), but we still set disabledByFailure so the UI can
      //    distinguish "fired once and done" from "failed and gave up".
      let failureCount = task.failureCount ?? 0;
      let disabledByFailure = task.disabledByFailure ?? false;
      if (succeeded) {
        failureCount = 0;
        disabledByFailure = false;
      } else {
        failureCount = failureCount + 1;
        if (failureCount >= MAX_LOCAL_SCHEDULE_FAILURES) {
          disabledByFailure = true;
        }
      }

      // Whether the task stays active after this fire:
      //  - delay: always set inactive after one fire (success or fail).
      //  - daily: stays active UNLESS auto-disabled by failure count.
      const staysActive = isDelay ? false : !disabledByFailure;

      return {
        ...task,
        lastTriggeredAt: triggeredAt,
        active: staysActive,
        nextRunAt: update.nextRunAt,
        failureCount,
        disabledByFailure,
        updatedAt: triggeredAt,
      };
    });

    if (mutated) {
      try {
        saveLocalScheduleTasks(merged);
      } catch (err) {
        // Persistence failed (quota / privacy mode). Log so the failure
        // is at least visible in the dev console — the service itself
        // has no UI to surface it. The merged state stays in memory
        // for this tick; the next tick will re-read storage from
        // scratch and attempt to fire again.
        console.warn(
          '[schedule] failed to persist fired task state — task may re-fire',
          err,
        );
      }
    }
  }

  private async fire(task: LocalScheduleTask): Promise<ScheduleFireResult> {
    if (!this.triggerCallback) {
      return { status: 'failed', error: 'No trigger callback wired' };
    }
    try {
      const res = await this.triggerCallback(task);
      if (res.ok) return { status: 'completed' };
      return {
        status: 'failed',
        error: res.error ?? 'Trigger reported failure',
      };
    } catch (err) {
      return {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
