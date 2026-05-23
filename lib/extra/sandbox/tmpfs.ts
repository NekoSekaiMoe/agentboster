import { exec } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ISandboxProvider,
  SandboxConfig,
  SandboxExecutionResult,
  SandboxInfo,
} from './types';

interface TmpfsSandboxState {
  info: SandboxInfo;
  dir: string;
}

const SANDBOX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_LENGTH = 50_000;

export class TmpfsSandboxProvider implements ISandboxProvider {
  private sandboxes = new Map<string, TmpfsSandboxState>();

  async create(config: SandboxConfig): Promise<SandboxInfo> {
    const id = `tmpfs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = await mkdtemp(join(tmpdir(), 'agentclaw-sandbox-'));

    const info: SandboxInfo = {
      id,
      type: 'tmpfs',
      status: 'ready',
      workspacePath: dir,
    };

    this.sandboxes.set(id, { info, dir });
    return info;
  }

  async execute(
    sandboxId: string,
    command: string,
    env?: Record<string, string>,
  ): Promise<SandboxExecutionResult> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error(`Sandbox not found: ${sandboxId}`);
    }

    sandbox.info.status = 'running';

    try {
      const result = await this.runCommand(command, sandbox.dir, env);
      sandbox.info.status = 'ready';
      return result;
    } catch (error) {
      sandbox.info.status = 'ready';
      throw error;
    }
  }

  async destroy(sandboxId: string): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return;

    sandbox.info.status = 'destroyed';

    try {
      await rm(sandbox.dir, { recursive: true, force: true });
    } catch {}

    this.sandboxes.delete(sandboxId);
  }

  async getStatus(sandboxId: string): Promise<SandboxInfo> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error(`Sandbox not found: ${sandboxId}`);
    }
    return sandbox.info;
  }

  async listSandboxes(_userId?: string): Promise<SandboxInfo[]> {
    return Array.from(this.sandboxes.values()).map((s) => s.info);
  }

  private runCommand(
    command: string,
    cwd: string,
    env?: Record<string, string>,
  ): Promise<SandboxExecutionResult> {
    return new Promise((resolve) => {
      const timedOut = false;

      const child = exec(command, {
        cwd,
        env: { ...process.env, ...env } as NodeJS.ProcessEnv,
        timeout: SANDBOX_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
        if (stdout.length > MAX_OUTPUT_LENGTH) {
          stdout = `${stdout.slice(0, MAX_OUTPUT_LENGTH)}\n... [output truncated]`;
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
        if (stderr.length > MAX_OUTPUT_LENGTH) {
          stderr = `${stderr.slice(0, MAX_OUTPUT_LENGTH)}\n... [output truncated]`;
        }
      });

      child.on('close', (code: number | null) => {
        resolve({
          exitCode: timedOut ? 124 : (code ?? 0),
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      });

      child.on('error', (err: Error) => {
        resolve({
          exitCode: 1,
          stdout: stdout.trim(),
          stderr: `${stderr}\nError: ${err.message}`.trim(),
        });
      });
    });
  }
}
