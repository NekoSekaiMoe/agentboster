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

function nextDailyRunAt(currentRunAt: Date): Date {
  return new Date(currentRunAt.getTime() + 24 * 60 * 60 * 1000);
}

export class ScheduleService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private triggerCallback: ScheduleTriggerCallback | null = null;
  private notificationCallback: ScheduleNotificationCallback | null = null;

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
      const tasks = loadLocalScheduleTasks();
      const now = Date.now();
      let mutated = false;

      for (const task of tasks) {
        if (!task.active) continue;
        if (!task.nextRunAt) continue;
        const runAt = new Date(task.nextRunAt);
        if (!Number.isFinite(runAt.getTime())) continue;
        if (runAt.getTime() > now) continue;

        const result = await this.fire(task);
        task.lastTriggeredAt = new Date().toISOString();
        if (task.type === 'delay') {
          task.active = false;
          task.nextRunAt = null;
        } else {
          task.nextRunAt = nextDailyRunAt(runAt).toISOString();
        }
        task.updatedAt = new Date().toISOString();
        mutated = true;

        this.notificationCallback?.(task, result);
      }

      if (mutated) saveLocalScheduleTasks(tasks);
    } finally {
      this.ticking = false;
    }
  }

  private async fire(
    task: LocalScheduleTask,
  ): Promise<ScheduleFireResult> {
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
