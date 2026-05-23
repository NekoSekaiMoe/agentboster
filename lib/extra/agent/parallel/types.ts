import type { SandboxConfig } from '../../sandbox/types';

export interface SubAgentTask {
  id: string;
  parentTaskId: string;
  description: string;
  context: Record<string, unknown>;
  sandboxConfig: SandboxConfig;
  timeout: number;
}

export interface SubAgentResult {
  taskId: string;
  success: boolean;
  output: string;
  error?: string;
  duration: number;
}

export interface IParallelOrchestrator {
  createSubAgent(
    parentTaskId: string,
    tasks: SubAgentTask[],
  ): Promise<SubAgentResult[]>;
  getSubAgentStatus(taskId: string): Promise<SubAgentResult>;
  cancelSubAgent(taskId: string): Promise<void>;
}
