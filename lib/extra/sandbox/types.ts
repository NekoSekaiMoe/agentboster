export type SandboxType = 'tmpfs' | 'docker' | 'chroot';

export interface SandboxConfig {
  type: SandboxType;
  image?: string;
  chrootPath?: string;
  persist: boolean;
  resources?: {
    cpuLimit: string;
    memoryLimit: string;
    diskLimit: string;
  };
}

export interface SandboxInfo {
  id: string;
  type: SandboxType;
  status: 'creating' | 'ready' | 'running' | 'destroyed';
  workspacePath: string;
}

export interface SandboxExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ISandboxProvider {
  create(config: SandboxConfig): Promise<SandboxInfo>;
  execute(
    sandboxId: string,
    command: string,
    env?: Record<string, string>,
  ): Promise<SandboxExecutionResult>;
  destroy(sandboxId: string): Promise<void>;
  getStatus(sandboxId: string): Promise<SandboxInfo>;
  listSandboxes(userId?: string): Promise<SandboxInfo[]>;
}

export interface ISandboxManager {
  selectSandbox(
    task: {
      description: string;
      riskLevel?: 'low' | 'medium' | 'high';
      persist?: boolean;
    },
    userPreference?: SandboxType,
  ): Promise<SandboxInfo>;
  createSandbox(config: SandboxConfig): Promise<SandboxInfo>;
  execute(sandboxId: string, command: string): Promise<SandboxExecutionResult>;
  destroySandbox(sandboxId: string): Promise<void>;
}
