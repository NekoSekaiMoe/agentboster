import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { Sandbox } from '@vercel/sandbox';

import { withSessionSandbox } from './manager';
import {
  SANDBOX_EXEC_WAIT_TIMEOUT_MS,
  SANDBOX_PUBLIC_PORTS,
  SANDBOX_WORKSPACE_DIR,
} from './runtime';

export interface SandboxActionContext {
  sandboxId: string;
  sandboxStatus: Sandbox['status'];
  created: boolean;
}

function resolveSandboxPath(targetPath: string, cwd?: string): string {
  if (targetPath.startsWith('/')) {
    return targetPath;
  }

  const base = cwd?.startsWith('/') ? cwd : SANDBOX_WORKSPACE_DIR;
  return `${base.replace(/\/+$/, '')}/${targetPath.replace(/^\/+/, '')}`;
}

function normalizeCwd(cwd?: string): string {
  if (!cwd) {
    return SANDBOX_WORKSPACE_DIR;
  }

  return cwd.startsWith('/')
    ? cwd.replace(/\/+$/, '') || '/'
    : resolveSandboxPath(cwd);
}

function toShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sanitizeFileName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return sanitized || 'artifact';
}

function getSandboxPublicPorts(sandbox: Sandbox): number[] {
  return [...new Set(sandbox.routes.map((route) => route.port))]
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function withSandboxAction<T>(
  sessionId: string,
  action: (sandbox: Sandbox, context: { created: boolean }) => Promise<T>,
): Promise<T & SandboxActionContext> {
  return withSessionSandbox(sessionId, async (sandbox, context) => {
    const result = await action(sandbox, context);
    return {
      ...result,
      sandboxId: sandbox.sandboxId,
      sandboxStatus: sandbox.status,
      created: context.created,
    };
  });
}

function buildSandboxRunCommand(input: {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  sudo?: boolean;
}) {
  const workingDirectory = normalizeCwd(input.cwd);
  const runAsRoot = input.sudo ?? false;

  if (input.args && input.args.length > 0) {
    return {
      shellCommand: [input.command, ...input.args].join(' '),
      params: {
        cmd: input.command,
        args: input.args,
        cwd: workingDirectory,
        env: input.env,
        sudo: runAsRoot,
      },
    };
  }

  return {
    shellCommand: input.command,
    params: {
      cmd: 'bash',
      args: ['-lc', input.command],
      cwd: workingDirectory,
      env: input.env,
      sudo: runAsRoot,
    },
  };
}

export interface RunSandboxCommandActionInput {
  sessionId: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  sudo?: boolean;
}

export type RunSandboxCommandCompletedActionResult = SandboxActionContext & {
  kind: 'completed';
  shellCommand: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type RunSandboxCommandRunningActionResult = SandboxActionContext & {
  kind: 'running';
  shellCommand: string;
  cmdId: string;
  startedAt: number;
  waitTimeoutMs: number;
  message: string;
};

export type RunSandboxCommandActionResult =
  | RunSandboxCommandCompletedActionResult
  | RunSandboxCommandRunningActionResult;

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === 'AbortError' || error.name === 'TimeoutError';
}

export async function runSandboxCommandAction(
  input: RunSandboxCommandActionInput,
): Promise<RunSandboxCommandActionResult> {
  const runCommand = buildSandboxRunCommand(input);

  return withSandboxAction(input.sessionId, async (sandbox) => {
    const detached = await sandbox.runCommand({
      ...runCommand.params,
      detached: true,
    });

    try {
      const result = await detached.wait({
        signal: AbortSignal.timeout(SANDBOX_EXEC_WAIT_TIMEOUT_MS),
      });

      const [stdout, stderr] = await Promise.all([
        result.stdout(),
        result.stderr(),
      ]);

      return {
        kind: 'completed' as const,
        shellCommand: runCommand.shellCommand,
        exitCode: result.exitCode,
        stdout,
        stderr,
      };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          kind: 'running' as const,
          shellCommand: runCommand.shellCommand,
          cmdId: detached.cmdId,
          startedAt: detached.startedAt,
          waitTimeoutMs: SANDBOX_EXEC_WAIT_TIMEOUT_MS,
          message: `Command is still running after ${Math.floor(SANDBOX_EXEC_WAIT_TIMEOUT_MS / 1000)} seconds.`,
        };
      }

      throw error;
    }
  });
}

export interface ReadSandboxFileActionInput {
  sessionId: string;
  path: string;
  cwd?: string;
}

export type ReadSandboxFileActionResult = SandboxActionContext & {
  path: string;
  content: string;
};

export async function readSandboxFileAction(
  input: ReadSandboxFileActionInput,
): Promise<ReadSandboxFileActionResult> {
  const resolvedPath = resolveSandboxPath(input.path, input.cwd);

  return withSandboxAction(input.sessionId, async (sandbox) => {
    const stream = await sandbox.readFile({ path: resolvedPath });
    if (stream === null) {
      throw new Error(`File not found: ${resolvedPath}`);
    }

    return {
      path: resolvedPath,
      content: await streamToString(stream),
    };
  });
}

export interface WriteSandboxFileActionInput {
  sessionId: string;
  path: string;
  content: string;
  cwd?: string;
}

export type WriteSandboxFileActionResult = SandboxActionContext & {
  path: string;
  bytes: number;
};

export async function writeSandboxFileAction(
  input: WriteSandboxFileActionInput,
): Promise<WriteSandboxFileActionResult> {
  const resolvedPath = resolveSandboxPath(input.path, input.cwd);

  return withSandboxAction(input.sessionId, async (sandbox) => {
    await sandbox.writeFiles([
      {
        path: resolvedPath,
        content: Buffer.from(input.content),
      },
    ]);

    return {
      path: resolvedPath,
      bytes: Buffer.byteLength(input.content),
    };
  });
}

export interface ResolveSandboxPublicPortActionInput {
  sessionId: string;
  port: number;
}

export type ResolveSandboxPublicPortActionResult = SandboxActionContext & {
  port: number;
  url: string;
  publicPorts: number[];
};

export async function resolveSandboxPublicPortAction(
  input: ResolveSandboxPublicPortActionInput,
): Promise<ResolveSandboxPublicPortActionResult> {
  return withSandboxAction(input.sessionId, async (sandbox) => {
    const publicPorts = getSandboxPublicPorts(sandbox);
    if (!publicPorts.includes(input.port)) {
      throw new Error(
        `Port ${input.port} is not exposed. Available ports: ${publicPorts.join(', ') || SANDBOX_PUBLIC_PORTS.join(', ')}. Sandbox ports are fixed when the sandbox is created, and new ports cannot be exposed at runtime.`,
      );
    }

    return {
      port: input.port,
      url: sandbox.domain(input.port),
      publicPorts,
    };
  });
}

export interface DownloadSandboxFileActionInput {
  sessionId: string;
  path: string;
  cwd?: string;
}

export type DownloadSandboxFileActionResult = SandboxActionContext & {
  sourcePath: string;
  fileName: string;
  localPath: string;
};

export async function downloadSandboxFileAction(
  input: DownloadSandboxFileActionInput,
): Promise<DownloadSandboxFileActionResult> {
  const resolvedPath = resolveSandboxPath(input.path, input.cwd);

  return withSandboxAction(input.sessionId, async (sandbox) => {
    const exists = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', `test -e ${toShellArg(resolvedPath)}`],
    });

    if (exists.exitCode !== 0) {
      throw new Error(`Path not found in sandbox: ${resolvedPath}`);
    }

    const isFileResult = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', `test -f ${toShellArg(resolvedPath)}`],
    });

    if (isFileResult.exitCode !== 0) {
      const isDirectoryResult = await sandbox.runCommand({
        cmd: 'bash',
        args: ['-lc', `test -d ${toShellArg(resolvedPath)}`],
      });

      if (isDirectoryResult.exitCode === 0) {
        throw new Error(
          `Only single-file export is supported. "${resolvedPath}" is a directory. Use the exec tool to compress files first (for example: zip -r export.zip <dir>) and then download the archive file.`,
        );
      }

      throw new Error(`Path is not a regular file: ${resolvedPath}`);
    }

    const fileName = path.posix.basename(resolvedPath) || 'artifact';
    const localTempName = `agentboster-export-${randomUUID()}-${sanitizeFileName(fileName)}`;

    const localPath = await sandbox.downloadFile(
      { path: resolvedPath },
      { path: localTempName, cwd: '/tmp' },
      { mkdirRecursive: true },
    );

    if (!localPath) {
      throw new Error(`Sandbox artifact not found: ${resolvedPath}`);
    }

    return {
      sourcePath: resolvedPath,
      fileName,
      localPath,
    };
  });
}
