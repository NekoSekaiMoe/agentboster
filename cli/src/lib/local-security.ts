import { writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { L0RuleEngine } from '@/lib/extra/security/l0_rules/engine';
import { LocalScorerProvider } from '@/lib/extra/security/scorer/local';
import type { ScoreRequest } from '@/lib/extra/security/scorer/types';

export type AuthorizationLevel = 'l0' | 'l1' | 'l2';

export type SecurityDecision = {
  ok: boolean;
  level: AuthorizationLevel;
  message: string;
  score?: number;
  reasoning?: string;
};

export type LocalToolResult = {
  ok: boolean;
  output?: unknown;
  error?: string;
};

const l0 = new L0RuleEngine();
const l1 = new LocalScorerProvider({
  baseUrl: process.env.AGENTBOSTER_SCORER_URL ?? 'http://127.0.0.1:11434/v1',
  model: process.env.AGENTBOSTER_SCORER_MODEL ?? 'llama3.1',
  timeout: 15_000,
  failurePolicy: 'open',
});

function resolvePath(path: unknown, cwd = process.cwd()): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('path must be a non-empty string.');
  }
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

function parseHunkHeader(
  line: string,
): { oldStart: number; newStart: number } | null {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match) {
    return null;
  }

  return {
    oldStart: Number.parseInt(match[1] ?? '1', 10),
    newStart: Number.parseInt(match[2] ?? '1', 10),
  };
}

function applyUnifiedPatch(current: string, patch: string): string {
  const currentLines = splitLines(current);
  const patchLines = patch.split('\n');
  const output: string[] = [];
  let currentIndex = 0;
  let inHunk = false;

  for (let i = 0; i < patchLines.length; i += 1) {
    const line = patchLines[i] ?? '';

    if (line.startsWith('diff --git') || line.startsWith('index ')) {
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue;
    }

    if (line.startsWith('@@')) {
      const hunk = parseHunkHeader(line);
      if (!hunk) {
        continue;
      }

      inHunk = true;
      while (
        currentIndex < hunk.oldStart - 1 &&
        currentIndex < currentLines.length
      ) {
        output.push(currentLines[currentIndex] ?? '');
        currentIndex += 1;
      }
      continue;
    }

    if (!inHunk) {
      continue;
    }

    if (line.startsWith('\\')) {
      continue;
    }

    const marker = line.charAt(0);
    const text = line.slice(1);

    if (marker === ' ') {
      if (currentLines[currentIndex] !== undefined) {
        output.push(currentLines[currentIndex] ?? '');
      } else {
        output.push(text);
      }
      currentIndex += 1;
      continue;
    }

    if (marker === '-') {
      currentIndex += 1;
      continue;
    }

    if (marker === '+') {
      output.push(text);
    }
  }

  while (currentIndex < currentLines.length) {
    output.push(currentLines[currentIndex] ?? '');
    currentIndex += 1;
  }

  return output.join('\n');
}

export async function executeLocalTool(
  toolName: string,
  toolInput: unknown,
): Promise<LocalToolResult> {
  if (typeof toolInput !== 'object' || toolInput === null) {
    return { ok: false, error: 'Invalid tool input (expected object).' };
  }

  const input = toolInput as Record<string, unknown>;
  switch (toolName) {
    case 'local_read_file': {
      const path = resolvePath(input.path);
      return { ok: true, output: await readFile(path, 'utf8') };
    }
    case 'local_write_file': {
      const path = resolvePath(input.path);
      const content = input.content;
      if (typeof content !== 'string') {
        return { ok: false, error: 'content must be a string.' };
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
      return { ok: true, output: `Wrote ${content.length} bytes to ${path}` };
    }
    case 'local_patch_file': {
      const path = resolvePath(input.path);
      const patch = input.patch;
      if (typeof patch !== 'string' || patch.length === 0) {
        return { ok: false, error: 'patch must be a non-empty string.' };
      }
      const current = await readFile(path, 'utf8').catch(() => '');
      const next = patch.includes('@@')
        ? applyUnifiedPatch(current, patch)
        : patch;
      await mkdir(dirname(path), { recursive: true });
      writeFileSync(path, next, 'utf8');
      return { ok: true, output: `Patched ${path}` };
    }
    case 'local_exec': {
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
        const MAX_OUTPUT = 100_000;

        child.stdout.on('data', (chunk: Buffer) => {
          if (stdout.length < MAX_OUTPUT) {
            stdout += chunk
              .toString('utf8')
              .slice(0, MAX_OUTPUT - stdout.length);
          }
        });
        child.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < MAX_OUTPUT) {
            stderr += chunk
              .toString('utf8')
              .slice(0, MAX_OUTPUT - stderr.length);
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
    default:
      return { ok: false, error: `Unknown local tool: ${toolName}` };
  }
}

function buildScoreRequest(command: string, cwd: string): ScoreRequest {
  return {
    action: 'shell',
    command,
    context: {
      workingDirectory: cwd,
      sandboxType: 'cli-local',
      userId: 'local-cli',
      agentId: 'cli',
      taskDescription: command,
    },
  };
}

export async function evaluateLocalCommand(
  command: string,
  cwd = process.cwd(),
): Promise<SecurityDecision> {
  const l0Result = await l0.evaluate(command, cwd);
  if (l0Result.action === 'block') {
    return { ok: false, level: 'l0', message: l0Result.message };
  }

  const score = await l1.evaluate(buildScoreRequest(command, cwd));
  if (score.level === 'unsafe') {
    return {
      ok: false,
      level: 'l1',
      message: score.reasoning,
      score: score.score,
      reasoning: score.reasoning,
    };
  }

  return {
    ok: true,
    level: score.level === 'inspect' ? 'l2' : 'l1',
    message: l0Result.message,
    score: score.score,
    reasoning: score.reasoning,
  };
}
