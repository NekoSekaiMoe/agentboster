import { CronJob } from 'cron';

import type { ITaskScheduler, ScheduledTask } from './types';

interface RunningTask {
  task: ScheduledTask;
  job: CronJob;
}

export class TaskScheduler implements ITaskScheduler {
  private tasks = new Map<string, RunningTask>();
  private onTaskTrigger: ((task: ScheduledTask) => Promise<void>) | null = null;

  setTaskTrigger(handler: (task: ScheduledTask) => Promise<void>): void {
    this.onTaskTrigger = handler;
  }

  async schedule(task: ScheduledTask): Promise<void> {
    if (this.tasks.has(task.id)) {
      await this.cancel(task.id);
    }

    const job = new CronJob(
      task.cronExpression,
      async () => {
        if (!task.enabled) return;
        task.lastRun = Date.now();
        if (this.onTaskTrigger) {
          await this.onTaskTrigger(task);
        }
      },
      null,
      true,
    );

    this.tasks.set(task.id, { task, job });
  }

  async cancel(taskId: string): Promise<void> {
    const running = this.tasks.get(taskId);
    if (!running) return;

    running.job.stop();
    this.tasks.delete(taskId);
  }

  async listTasks(_userId?: string): Promise<ScheduledTask[]> {
    return Array.from(this.tasks.values()).map((rt) => rt.task);
  }

  async update(taskId: string, updates: Partial<ScheduledTask>): Promise<void> {
    const running = this.tasks.get(taskId);
    if (!running) throw new Error(`Task not found: ${taskId}`);

    Object.assign(running.task, updates);

    if (updates.cronExpression || updates.enabled !== undefined) {
      await this.schedule(running.task);
    }
  }

  async triggerNow(taskId: string): Promise<void> {
    const running = this.tasks.get(taskId);
    if (!running) throw new Error(`Task not found: ${taskId}`);

    if (this.onTaskTrigger) {
      await this.onTaskTrigger(running.task);
    }
  }

  stopAll(): void {
    for (const [id] of this.tasks) {
      this.cancel(id);
    }
  }
}
