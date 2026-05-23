import { ofetch } from 'ofetch';
import type {
  DaemonConfig,
  DaemonTask,
  DaemonTaskResult,
  IAgentDaemonClient,
} from './types';

export class AgentDaemonClient implements IAgentDaemonClient {
  private config: DaemonConfig | null = null;
  private connected = false;
  private jwtToken: string | null = null;

  async connect(config: DaemonConfig): Promise<boolean> {
    this.config = config;

    try {
      const loginResult = await this.request<{ token: string }>(
        'POST',
        '/auth/login',
        {
          username: config.credentials.webuiUsername,
          password: config.credentials.webuiPassword,
        },
      );

      if (loginResult?.token) {
        this.jwtToken = loginResult.token;
        this.connected = true;
        return true;
      }

      if (config.authType === 'password') {
        this.connected = true;
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  async submitTask(task: DaemonTask): Promise<string> {
    this.ensureConnected();

    const result = await this.request<{ taskId: string }>('POST', '/tasks', {
      command: task.command,
      sandboxConfig: task.sandboxConfig,
      timeout: task.timeout,
    });

    return result?.taskId ?? '';
  }

  async getTaskResult(taskId: string): Promise<DaemonTaskResult> {
    this.ensureConnected();

    const result = await this.request<DaemonTaskResult>(
      'GET',
      `/tasks/${taskId}`,
    );
    return (
      result ?? { status: 'failed', output: '', error: 'No result returned' }
    );
  }

  async cancelTask(taskId: string): Promise<boolean> {
    this.ensureConnected();

    try {
      await this.request('DELETE', `/tasks/${taskId}`);
      return true;
    } catch {
      return false;
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.config) return false;

    try {
      await this.request('GET', '/health');
      return true;
    } catch {
      return false;
    }
  }

  disconnect(): void {
    this.connected = false;
    this.jwtToken = null;
    this.config = null;
  }

  private ensureConnected(): void {
    if (!this.connected || !this.config) {
      throw new Error('Daemon client not connected. Call connect() first.');
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T | null> {
    if (!this.config) return null;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.jwtToken) {
      headers.Authorization = `Bearer ${this.jwtToken}`;
    } else if (this.config.authType === 'password') {
      const credentials = Buffer.from(
        `${this.config.credentials.webuiUsername}:${this.config.credentials.webuiPassword}`,
      ).toString('base64');
      headers.Authorization = `Basic ${credentials}`;
    }

    const response = await ofetch<T>(`${this.config.host}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      timeout: 30000,
    });

    return response;
  }
}
