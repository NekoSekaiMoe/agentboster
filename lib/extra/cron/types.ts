export interface ScheduledTask {
  id: string;
  cronExpression: string;
  action: {
    type: 'agent_command' | 'notification';
    command: string;
    agentId?: string;
  };
  enabled: boolean;
  lastRun?: number;
  nextRun: number;
}

export interface PollerConfig {
  interval: number;
  taskType: string;
  handler: string;
  enabled: boolean;
}

export interface WorkerStatus {
  workerId: string;
  status: 'idle' | 'busy';
  currentTask?: string;
  lastHeartbeat: number;
}

export interface ITaskScheduler {
  schedule(task: ScheduledTask): Promise<void>;
  cancel(taskId: string): Promise<void>;
  listTasks(userId?: string): Promise<ScheduledTask[]>;
  update(taskId: string, updates: Partial<ScheduledTask>): Promise<void>;
}

export interface IDynamicPoller {
  startPoller(config: PollerConfig): void;
  stopPoller(taskType: string): void;
  getWorkerPoolStatus(): Promise<WorkerStatus[]>;
  scaleWorkers(count: number): void;
}
