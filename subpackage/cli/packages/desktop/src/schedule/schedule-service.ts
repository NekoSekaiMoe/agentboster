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

/**
 * Called once when the scheduler permanently halts itself due to an
 * unrecoverable error (e.g. localStorage quota exhaustion — see
 * mergeFiredResults). The argument is the error that triggered the
 * halt. Wired by main.ts to surface a user-visible warning so the
 * user understands why their scheduled tasks stopped firing.
 */
export type ScheduleHaltedCallback = (error: unknown) => void;

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
  // `currentRunAt` is retained in the signature for caller stability
  // but no longer used as the anchor — see the function body comments
  // for why we anchor at `now` instead.
  void currentRunAt;
  const nowMs = Date.now();

  if (!dailyTime || !timezone) {
    // Without timezone info we can't do a wall-clock lookup; fall back
    // to +24h from NOW (not currentRunAt) so the result is always
    // strictly in the future. Anchoring to currentRunAt could return
    // a past instant when the task was overdue, causing the scheduler
    // to fire the same task every 30s as it slowly caught up day by
    // day.
    return new Date(nowMs + 24 * 60 * 60 * 1000);
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(dailyTime.trim());
  if (!match) {
    return new Date(nowMs + 24 * 60 * 60 * 1000);
  }
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return new Date(nowMs + 24 * 60 * 60 * 1000);
  }

  // Anchor the day-walk at NOW (not currentRunAt) so that a task that
  // has been overdue for more than 3 days (e.g. machine was off for a
  // week) still resolves to a future instant. Walking from currentRunAt
  // could produce candidates that are all still in the past, then fall
  // through to the +24h fallback also in the past — looping forever.
  // Starting at today and walking forward up to 7 days guarantees we
  // find the next wall-clock occurrence.
  const now = new Date();
  for (let offsetDays = 0; offsetDays <= 7; offsetDays++) {
    const base = new Date(now);
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
    if (instant.getTime() > nowMs) {
      return instant;
    }
  }

  // All 7 candidates were in the past (only possible if the timezone
  // conversion is broken). Anchor to now to guarantee forward progress.
  return new Date(nowMs + 24 * 60 * 60 * 1000);
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
  private haltedCallback: ScheduleHaltedCallback | null = null;
  // Snapshot of tasks captured at the start of each tick(), used by
  // mergeFiredResults to detect concurrent edits during the fire await.
  // Reset to null when a tick completes.
  private preFireSnapshot: Map<string, LocalScheduleTask> | null = null;
  // Whether the scheduler has permanently stopped due to an
  // unrecoverable persistence failure. Once true the service refuses
  // new ticks until `reset()` / restart.
  private halted = false;

  setTriggerCallback(cb: ScheduleTriggerCallback): void {
    this.triggerCallback = cb;
  }

  setNotificationCallback(cb: ScheduleNotificationCallback): void {
    this.notificationCallback = cb;
  }

  /**
   * Install a one-shot callback invoked when the scheduler halts
   * itself due to an unrecoverable error (currently only persistence
   * failure — see mergeFiredResults). main.ts uses this to surface a
   * desktop notification so the user knows tasks are paused.
   */
  setHaltedCallback(cb: ScheduleHaltedCallback): void {
    this.haltedCallback = cb;
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
    if (this.halted) return; // scheduler halted by unrecoverable error
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
        // No in-memory dedup: persistence failure halts the scheduler
        // (see mergeFiredResults) so we can't loop forever, and a
        // dedup Set that's keyed only by task id would skip future
        // legitimate fires of daily tasks (every fire of the same
        // task has the same id but a different nextRunAt). The
        // previous dedup-on-id form caused daily tasks to fire only
        // once per process lifetime — see review follow-up.

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
        // No in-memory dedup bookkeeping on the success path. The
        // scheduler is durable here (state written to disk), so the
        // next tick's load() will see the new nextRunAt and skip
        // naturally. Recording dedup-on-id would break daily tasks
        // (see comment in tick()).
      } catch (err) {
        // Persistence failed (quota / privacy mode). Halt the scheduler
        // so we don't enter an infinite re-fire loop: without the
        // post-fire state on disk, the next tick would re-read stale
        // storage and dispatch every just-fired task again.
        //
        // The in-memory dedup set still keeps this tick's fired ids
        // from re-firing on subsequent ticks that DID somehow run
        // (e.g. via test harness), but halting is the correct
        // top-level response: there's no point running the loop when
        // we can't durably commit results. The UI is notified via
        // the optional onHalted callback (wired by main.ts).
        this.halted = true;
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
        console.error(
          '[schedule] persistence failed — scheduler halted to prevent re-fire loop',
          err,
        );
        try {
          this.haltedCallback?.(err);
        } catch {
          // Best-effort.
        }
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
