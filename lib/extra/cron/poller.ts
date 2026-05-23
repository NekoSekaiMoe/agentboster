import type { IDynamicPoller, PollerConfig, WorkerStatus } from './types';

interface PollerState {
  config: PollerConfig;
  intervalId: ReturnType<typeof setInterval> | null;
}

interface WorkerState {
  id: string;
  status: 'idle' | 'busy';
  currentTask?: string;
  lastHeartbeat: number;
}

export class DynamicPoller implements IDynamicPoller {
  private pollers = new Map<string, PollerState>();
  private workers: WorkerState[] = [];
  private minWorkers: number;
  private maxWorkers: number;
  private onTaskHandler: ((taskType: string) => Promise<void>) | null = null;

  constructor(minWorkers = 2, maxWorkers = 8) {
    this.minWorkers = minWorkers;
    this.maxWorkers = maxWorkers;

    for (let i = 0; i < minWorkers; i++) {
      this.workers.push(this.createWorker(i));
    }
  }

  setTaskHandler(handler: (taskType: string) => Promise<void>): void {
    this.onTaskHandler = handler;
  }

  startPoller(config: PollerConfig): void {
    if (this.pollers.has(config.taskType)) {
      this.stopPoller(config.taskType);
    }

    const state: PollerState = {
      config,
      intervalId: null,
    };

    if (config.enabled) {
      state.intervalId = setInterval(() => {
        this.executePoll(config.taskType);
      }, config.interval * 1000);
    }

    this.pollers.set(config.taskType, state);
  }

  stopPoller(taskType: string): void {
    const state = this.pollers.get(taskType);
    if (!state) return;

    if (state.intervalId) {
      clearInterval(state.intervalId);
    }
    this.pollers.delete(taskType);
  }

  async getWorkerPoolStatus(): Promise<WorkerStatus[]> {
    return this.workers.map((w) => ({
      workerId: w.id,
      status: w.status,
      currentTask: w.currentTask,
      lastHeartbeat: w.lastHeartbeat,
    }));
  }

  scaleWorkers(count: number): void {
    const clampedCount = Math.max(
      this.minWorkers,
      Math.min(this.maxWorkers, count),
    );
    const currentCount = this.workers.length;

    if (clampedCount > currentCount) {
      for (let i = currentCount; i < clampedCount; i++) {
        this.workers.push(this.createWorker(i));
      }
    } else if (clampedCount < currentCount) {
      const idleWorkers = this.workers.filter((w) => w.status === 'idle');
      const toRemove = currentCount - clampedCount;

      for (let i = 0; i < toRemove && i < idleWorkers.length; i++) {
        const idx = this.workers.findIndex((w) => w.id === idleWorkers[i].id);
        if (idx >= 0) {
          this.workers.splice(idx, 1);
        }
      }
    }
  }

  stopAll(): void {
    for (const [taskType] of this.pollers) {
      this.stopPoller(taskType);
    }
  }

  private createWorker(index: number): WorkerState {
    return {
      id: `worker-${index}`,
      status: 'idle',
      lastHeartbeat: Date.now(),
    };
  }

  private async executePoll(taskType: string): Promise<void> {
    const worker = this.workers.find((w) => w.status === 'idle');
    if (!worker) {
      this.autoScaleUp();
      return;
    }

    worker.status = 'busy';
    worker.currentTask = taskType;
    worker.lastHeartbeat = Date.now();

    try {
      if (this.onTaskHandler) {
        await this.onTaskHandler(taskType);
      }
    } catch {
    } finally {
      worker.status = 'idle';
      worker.currentTask = undefined;
      worker.lastHeartbeat = Date.now();
    }
  }

  private autoScaleUp(): void {
    if (this.workers.length < this.maxWorkers) {
      this.scaleWorkers(this.workers.length + 1);
    }
  }
}
