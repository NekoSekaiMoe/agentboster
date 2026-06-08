import type {
  IParallelOrchestrator,
  SubAgentResult,
  SubAgentTask,
} from './types';

interface RunningTask {
  task: SubAgentTask;
  startTime: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: SubAgentResult;
  abortController: AbortController;
}

export class ParallelOrchestrator implements IParallelOrchestrator {
  private tasks = new Map<string, RunningTask>();
  private maxParallel: number;

  constructor(maxParallel = 4) {
    this.maxParallel = maxParallel;
  }

  async createSubAgent(
    _parentTaskId: string,
    tasks: SubAgentTask[],
  ): Promise<SubAgentResult[]> {
    const runningTasks: RunningTask[] = [];

    for (const task of tasks) {
      const abortController = new AbortController();
      const running: RunningTask = {
        task,
        startTime: Date.now(),
        status: 'pending',
        abortController,
      };
      this.tasks.set(task.id, running);
      runningTasks.push(running);
    }

    const results = await this.runWithConcurrencyLimit(runningTasks);
    return results;
  }

  async getSubAgentStatus(taskId: string): Promise<SubAgentResult> {
    const running = this.tasks.get(taskId);
    if (!running) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (running.result) {
      return running.result;
    }

    return {
      taskId,
      success: false,
      output: '',
      error: `Task is ${running.status}`,
      duration: Date.now() - running.startTime,
    };
  }

  async cancelSubAgent(taskId: string): Promise<void> {
    const running = this.tasks.get(taskId);
    if (!running) return;

    running.status = 'cancelled';
    running.abortController.abort();
    running.result = {
      taskId,
      success: false,
      output: '',
      error: 'Task cancelled by user',
      duration: Date.now() - running.startTime,
    };
  }

  private async runWithConcurrencyLimit(
    tasks: RunningTask[],
  ): Promise<SubAgentResult[]> {
    const results: SubAgentResult[] = [];
    const queue = [...tasks];
    const running: Promise<void>[] = [];

    while (queue.length > 0 || running.length > 0) {
      while (running.length < this.maxParallel && queue.length > 0) {
        const task = queue.shift();
        if (!task) break;
        const promise = this.executeTask(task).then((result) => {
          results.push(result);
          const idx = running.indexOf(promise);
          if (idx >= 0) running.splice(idx, 1);
        });
        running.push(promise);
      }

      if (running.length > 0) {
        await Promise.race(running);
      }
    }

    return results;
  }

  private async executeTask(running: RunningTask): Promise<SubAgentResult> {
    running.status = 'running';
    const startTime = Date.now();

    try {
      const output = await this.runSubAgentTask(
        running.task,
        running.abortController.signal,
      );
      const result: SubAgentResult = {
        taskId: running.task.id,
        success: true,
        output,
        duration: Date.now() - startTime,
      };
      running.result = result;
      running.status = 'completed';
      return result;
    } catch (error) {
      const result: SubAgentResult = {
        taskId: running.task.id,
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      };
      running.result = result;
      running.status = 'failed';
      return result;
    }
  }

  private async runSubAgentTask(
    task: SubAgentTask,
    signal: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Task timed out after ${task.timeout}ms`));
      }, task.timeout);

      const onAbort = () => {
        clearTimeout(timeout);
        reject(new Error('Task aborted'));
      };

      signal.addEventListener('abort', onAbort, { once: true });

      (async () => {
        try {
          const output = await this.simulateAgentExecution(task);
          clearTimeout(timeout);
          signal.removeEventListener('abort', onAbort);
          resolve(output);
        } catch (error) {
          clearTimeout(timeout);
          signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      })();
    });
  }

  private async simulateAgentExecution(task: SubAgentTask): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return `Completed: ${task.description}`;
  }
}
