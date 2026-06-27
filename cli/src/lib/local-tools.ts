import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';

/**
 * Execute a \`local_*\` tool call on the user's filesystem. The LLM
 * selected the tool and provided input via the SSE stream; the CLI is
 * the only place where these tools can actually run (the web has no
 * access to the user's machine).
 *
 * Returns {ok, output?, error?} — same shape as the
 * localToolResultPayloadSchema on the web side.
 */
export type LocalToolResult = {
  ok: boolean;
  output?: unknown;
  error?: string;
};

export async function executeLocalTool(
  toolName: string,
  toolInput: unknown,
): Promise<LocalToolResult> {
  if (typeof toolInput !== 'object' || toolInput === null) {
    return { ok: false, error: 'Invalid tool input (expected object).' };
  }
  const input = toolInput as Record<string, unknown>;

  try {
    switch (toolName) {
      case 'local_read_file':
        return await executeReadFile(input);
      case 'local_write_file':
        return await executeWriteFile(input);
      case 'local_exec':
        return await executeExec(input);
      default:
        return {
          ok: false,
          error: `Unknown local tool: ${toolName}`,
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

function resolvePath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('path must be a non-empty string.');
  }
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

async function executeReadFile(
  input: Record<string, unknown>,
): Promise<LocalToolResult> {
  const path = resolvePath(input.path);
  const content = await readFile(path, 'utf8');
  return { ok: true, output: content };
}

async function executeWriteFile(
  input: Record<string, unknown>,
): Promise<LocalToolResult> {
  const path = resolvePath(input.path);
  const content = input.content;
  if (typeof content !== 'string') {
    return { ok: false, error: 'content must be a string.' };
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  return {
    ok: true,
    output: `Wrote ${content.length} bytes to ${path}`,
  };
}

async function executeExec(
  input: Record<string, unknown>,
): Promise<LocalToolResult> {
  const command = input.command;
  if (typeof command !== 'string' || command.length === 0) {
    return { ok: false, error: 'command must be a non-empty string.' };
  }
  const cwd =
    typeof input.cwd === 'string'
      ? isAbsolute(input.cwd)
        ? input.cwd
        : resolve(process.cwd(), input.cwd)
      : process.cwd();

  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      shell: process.env.SHELL ?? '/bin/sh',
      cwd,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const MAX_OUTPUT = 100_000; // truncate runaway output

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) {
        stdout += chunk.toString('utf8').slice(0, MAX_OUTPUT - stdout.length);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) {
        stderr += chunk.toString('utf8').slice(0, MAX_OUTPUT - stderr.length);
      }
    });
    child.on('error', (err) => {
      resolvePromise({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      const trimmedStdout = stdout.slice(0, MAX_OUTPUT);
      const trimmedStderr = stderr.slice(0, MAX_OUTPUT);
      if (code === 0) {
        resolvePromise({
          ok: true,
          output: trimmedStderr
            ? `${trimmedStdout}\n[stderr]\n${trimmedStderr}`
            : trimmedStdout,
        });
      } else {
        resolvePromise({
          ok: false,
          error: `Exit ${code}.\n[stdout]\n${trimmedStdout}\n[stderr]\n${trimmedStderr}`,
        });
      }
    });
  });
}
