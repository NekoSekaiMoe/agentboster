import type {
  ISandboxManager,
  ISandboxProvider,
  SandboxConfig,
  SandboxExecutionResult,
  SandboxInfo,
  SandboxType,
} from './types';

interface StoredSandbox {
  info: SandboxInfo;
  provider: ISandboxProvider;
}

export class SandboxManager implements ISandboxManager {
  private sandboxes = new Map<string, StoredSandbox>();
  private defaultType: SandboxType;

  constructor(defaultType: SandboxType = 'docker') {
    this.defaultType = defaultType;
  }

  async selectSandbox(
    task: {
      description: string;
      riskLevel?: 'low' | 'medium' | 'high';
      persist?: boolean;
    },
    userPreference?: SandboxType,
  ): Promise<SandboxInfo> {
    const type = userPreference ?? this.autoSelectType(task);
    const provider = this.createProvider(type);
    const config: SandboxConfig = {
      type,
      persist: task.persist ?? false,
    };
    return provider.create(config);
  }

  async createSandbox(config: SandboxConfig): Promise<SandboxInfo> {
    const provider = this.createProvider(config.type);
    const info = await provider.create(config);
    this.sandboxes.set(info.id, { info, provider });
    return info;
  }

  async execute(
    sandboxId: string,
    command: string,
  ): Promise<SandboxExecutionResult> {
    const stored = this.sandboxes.get(sandboxId);
    if (!stored) {
      throw new Error(`Sandbox not found: ${sandboxId}`);
    }
    return stored.provider.execute(sandboxId, command);
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    const stored = this.sandboxes.get(sandboxId);
    if (!stored) return;

    await stored.provider.destroy(sandboxId);
    this.sandboxes.delete(sandboxId);
  }

  async getSandboxInfo(sandboxId: string): Promise<SandboxInfo | null> {
    const stored = this.sandboxes.get(sandboxId);
    if (!stored) return null;
    return stored.provider.getStatus(sandboxId);
  }

  async listAllSandboxes(userId?: string): Promise<SandboxInfo[]> {
    const results: SandboxInfo[] = [];
    for (const [id] of this.sandboxes) {
      const info = await this.getSandboxInfo(id);
      if (info && (!userId || info.id.includes(userId))) {
        results.push(info);
      }
    }
    return results;
  }

  private autoSelectType(task: {
    riskLevel?: 'low' | 'medium' | 'high';
    persist?: boolean;
  }): SandboxType {
    if (task.riskLevel === 'high') return 'docker-strict';
    if (task.persist) return 'lxc';
    if (task.riskLevel === 'medium') return 'lxc';
    return this.defaultType;
  }

  private createProvider(type: SandboxType): ISandboxProvider {
    switch (type) {
      case 'docker':
      case 'docker-strict':
      case 'lxc':
        throw new Error(
          `Sandbox provider "${type}" is handled by Agent Daemon and is not implemented in the web-side sandbox manager.`,
        );
      default: {
        const unsupported: never = type;
        throw new Error(`Unsupported sandbox type: ${unsupported}`);
      }
    }
  }
}
