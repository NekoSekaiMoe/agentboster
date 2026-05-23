import type { SandboxConfig } from '../../sandbox/types';

export interface DaemonConfig {
  agentId: string;
  host: string;
  authType: 'jwt' | 'password';
  credentials: {
    webuiUsername: string;
    webuiPassword: string;
    systemUsername: string;
    systemPassword: string;
  };
}

export interface DaemonTask {
  id: string;
  command: string;
  sandboxConfig: SandboxConfig;
  timeout: number;
}

export interface DaemonTaskResult {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  output: string;
  error?: string;
  exitCode?: number;
  duration?: number;
}

export interface IAgentDaemonClient {
  connect(config: DaemonConfig): Promise<boolean>;
  submitTask(task: DaemonTask): Promise<string>;
  getTaskResult(taskId: string): Promise<DaemonTaskResult>;
  cancelTask(taskId: string): Promise<boolean>;
  healthCheck(): Promise<boolean>;
  disconnect(): void;
}
