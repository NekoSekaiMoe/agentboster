import { approvalHookBuilder } from '@/lib/workflow/agent/hooks';
import { sendApprovalRequestReminderStep } from '@/lib/workflow/agent/sender/bot-steps';
import {
  writeRuntimeEvent,
  writeToolApprovalRequest,
  writeToolOutputDenied,
} from '@/lib/workflow/agent/sender/writers';
import { createLogger } from '@/lib/utils/logger';
import type { ExecutedAgentdNode } from '@/lib/extra/agent/agentd-tools-client';
import { tool } from 'ai';
import { z } from 'zod';
import { defineBuildInTool } from '../define';

const logger = createLogger('workflow.agent.tools.execute');

const SANDBOX_TIMEOUT_MS = 5 * 60 * 1000;
const SANDBOX_MAX_OUTPUT_LENGTH = 30_000;
const SANDBOX_PUBLIC_PORTS = [3000, 4173, 5173] as const;

const execInputSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  sudo: z.boolean().optional(),
  nodeId: z
    .string()
    .optional()
    .describe(
      'Specific agentd node ID to execute on. If not provided, automatically selects the best node.',
    ),
});

const readFileInputSchema = z.object({
  path: z.string().min(1),
  cwd: z.string().optional(),
  nodeId: z.string().optional().describe('Specific agentd node ID'),
});

const writeFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  cwd: z.string().optional(),
  nodeId: z.string().optional().describe('Specific agentd node ID'),
});

const publicPortInputSchema = z.object({
  port: z.number().int().min(1).max(65535),
});

const exportFileInputSchema = z.object({
  path: z.string().min(1),
  cwd: z.string().optional(),
});

type ExecInput = z.infer<typeof execInputSchema>;
type ReadFileInput = z.infer<typeof readFileInputSchema>;
type WriteFileInput = z.infer<typeof writeFileInputSchema>;
type PublicPortInput = z.infer<typeof publicPortInputSchema>;
type ExportFileInput = z.infer<typeof exportFileInputSchema>;
type SandboxApprovalResponse = {
  approved: boolean;
  comment?: string;
};

interface SandboxExecOutput {
  kind: 'exec';
  exitCode: number;
  stdout: string;
  stderr: string;
  backend: 'agentd' | 'vercel-fallback';
  /** Which agentd node actually ran this call. Present only on the
   *  agentd backend; the fallback path has no node. */
  node?: ExecutedAgentdNode;
}

interface SandboxReadOutput {
  kind: 'read';
  path: string;
  content: string;
  backend: 'agentd' | 'vercel-fallback';
  node?: ExecutedAgentdNode;
}

interface SandboxWriteOutput {
  kind: 'write';
  path: string;
  bytes: number;
  backend: 'agentd' | 'vercel-fallback';
  node?: ExecutedAgentdNode;
}

interface SandboxPortOutput {
  kind: 'port';
  port: number;
  url: string;
  publicPorts: number[];
  backend: 'agentd' | 'vercel-fallback';
}

interface SandboxExportOutput {
  kind: 'export';
  sourcePath: string;
  fileName: string;
  url: string;
  size: number;
  backend: 'agentd' | 'vercel-fallback';
}

interface SandboxRunningOutput {
  kind: 'running';
  shellCommand: string;
  cmdId: string;
  startedAt: number;
  waitTimeoutMs: number;
  message: string;
}

interface SandboxDeniedOutput {
  approved: boolean;
  denied: boolean;
  reason?: string;
}

// biome-ignore lint/correctness/noUnusedVariables: reserved public union type for sandbox tool results; intentionally kept exported even if currently unreferenced internally
type SandboxToolResult =
  | SandboxExecOutput
  | SandboxReadOutput
  | SandboxWriteOutput
  | SandboxPortOutput
  | SandboxExportOutput
  | SandboxRunningOutput
  | SandboxDeniedOutput;

// ── Agent Daemon execution ──────────────────────────────────────────

let fallbackNotified = false;

async function execOnAgentd(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  nodeId?: string,
  workspaceLockAcquired?: boolean,
): Promise<{
  success: boolean;
  data?: string;
  error?: string;
  /** Set when an L0 block rule denied the call. Callers must NOT fall
   *  back to Vercel Sandbox when this is true — the block is final. */
  blocked?: boolean;
  /** Identity of the node the call actually ran on, forwarded from
   *  execToolOnAgentd. Absent on the L0-block short-circuit (no dispatch
   *  happened). Threaded into the SandboxOutput so the chat tool card can
   *  show which machine executed the call. */
  node?: ExecutedAgentdNode;
} | null> {
  'use step';

  try {
    const [{ isAgentdAvailable }, { execToolOnAgentd }] = await Promise.all([
      import('../../dispatch'),
      import('@/lib/extra/agent/agentd-tools-client'),
    ]);
    const available = await isAgentdAvailable();
    if (!available) {
      if (!fallbackNotified) {
        fallbackNotified = true;
        console.warn(
          '[sandbox] Agent Daemon offline, using Vercel Sandbox fallback',
        );
      }
      return null;
    }

    // L0 deny gate on the online agentd path. This was previously only
    // enforced on the Vercel Sandbox fallback (further below), leaving
    // a hole: when agentd was online, agentd's own L0 was assumed to
    // run, but the synchronous POST /api/v1/tools/exec handler in agentd
    // (Manager.ExecuteTool) was the one path that bypassed Gatekeeper.
    // That agentd gap is also being fixed, but running L0 here is
    // defense-in-depth and gives the user immediate feedback in the
    // workflow stream rather than waiting for an agentd round-trip.
    //
    // Scope is 'global' (same as the fallback path) because the factory
    // context exposes sessionId but not agentId.
    //
    // Only exec/readFile/writeFile carry a command/path payload worth
    // checking; agentd-side L0 also covers path/network rules.
    const l0Target =
      toolName === 'exec'
        ? String(toolInput.command ?? '')
        : String(toolInput.path ?? toolInput.command ?? '');
    if (l0Target) {
      const { evaluateL0 } = await import('@/lib/security/l0-engine');
      const l0 = await evaluateL0('global', l0Target);
      if (l0.blocked) {
        return {
          success: false,
          blocked: true,
          error: `L0 rule denied: ${l0.reason}`,
        };
      }
    }

    return await execToolOnAgentd(
      sessionId,
      toolName,
      toolInput,
      nodeId,
      undefined,
      workspaceLockAcquired,
    );
  } catch (error) {
    console.warn(
      '[sandbox] Agent Daemon exec failed, falling back to Vercel Sandbox',
      {
        sessionId,
        toolName,
        nodeId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return null;
  }
}

function parseAgentdResult(raw: string): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  try {
    const parsed = JSON.parse(raw);
    return {
      stdout: parsed.stdout || parsed.data || raw,
      stderr: parsed.stderr || '',
      exitCode: parsed.exit_code ?? parsed.exitCode ?? 0,
    };
  } catch {
    return { stdout: raw, stderr: '', exitCode: 0 };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function truncateStreamOutput(
  output: string,
  maxLength: number,
  streamName: 'stdout' | 'stderr',
): string {
  if (output.length <= maxLength) {
    return output;
  }

  const truncatedLength = output.length - maxLength;
  return `${output.slice(
    0,
    maxLength,
  )}\n\n[${streamName} truncated: ${truncatedLength} characters removed]`;
}

// ── Vercel Sandbox execution (fallback) ─────────────────────────────

async function executeSandboxCommandStep(
  input: ExecInput & {
    sessionId: string;
    runId: string;
  },
) {
  'use step';

  const { runSandboxCommandAction } = await import('@/lib/core/sandbox');
  const { patchSandboxRuntime } = await import('@/lib/core/sandbox/runtime');
  const { sessionId, runId, command, args, cwd, env, sudo } = input;
  const shellCommand =
    args && args.length > 0 ? [command, ...args].join(' ') : command;

  await patchSandboxRuntime(sessionId, {
    status: 'running',
    lastActiveAt: nowIso(),
    timeoutMs: SANDBOX_TIMEOUT_MS,
    lastCommand: shellCommand,
    lastExitCode: null,
    lastError: null,
  });

  try {
    const result = await runSandboxCommandAction({
      sessionId,
      command,
      args,
      cwd,
      env,
      sudo,
    });

    if (result.kind === 'running') {
      await writeRuntimeEvent({
        event: result.created ? 'sandbox-created' : 'sandbox-reused',
        sessionId,
        runId,
        sandboxId: result.sandboxId,
        status: result.sandboxStatus,
      });
      await writeRuntimeEvent({
        event: 'sandbox-command-start',
        sessionId,
        runId,
        sandboxId: result.sandboxId,
        command: result.shellCommand,
        status: result.sandboxStatus,
      });

      await patchSandboxRuntime(sessionId, {
        status: 'running',
        lastActiveAt: nowIso(),
        timeoutMs: SANDBOX_TIMEOUT_MS,
        lastCommand: result.shellCommand,
        lastExitCode: null,
        lastError: null,
      });
      await writeRuntimeEvent({
        event: 'sandbox-command-running',
        sessionId,
        runId,
        sandboxId: result.sandboxId,
        command: result.shellCommand,
        status: result.sandboxStatus,
        message: result.message,
      });

      return {
        running: true,
        shellCommand: result.shellCommand,
        cmdId: result.cmdId,
        startedAt: result.startedAt,
        waitTimeoutMs: result.waitTimeoutMs,
        message: result.message,
      };
    }

    const finalResult = {
      running: false,
      exitCode: result.exitCode,
      stdout: truncateStreamOutput(
        result.stdout,
        SANDBOX_MAX_OUTPUT_LENGTH,
        'stdout',
      ),
      stderr: truncateStreamOutput(
        result.stderr,
        SANDBOX_MAX_OUTPUT_LENGTH,
        'stderr',
      ),
    };

    await writeRuntimeEvent({
      event: result.created ? 'sandbox-created' : 'sandbox-reused',
      sessionId,
      runId,
      sandboxId: result.sandboxId,
      status: result.sandboxStatus,
    });
    await writeRuntimeEvent({
      event: 'sandbox-command-start',
      sessionId,
      runId,
      sandboxId: result.sandboxId,
      command: result.shellCommand,
      status: result.sandboxStatus,
    });

    await patchSandboxRuntime(sessionId, {
      status: 'running',
      lastActiveAt: nowIso(),
      timeoutMs: SANDBOX_TIMEOUT_MS,
      lastCommand: result.shellCommand,
      lastExitCode: result.exitCode,
      lastError: finalResult.stderr || null,
    });
    await writeRuntimeEvent({
      event: 'sandbox-command-finish',
      sessionId,
      runId,
      sandboxId: result.sandboxId,
      command: result.shellCommand,
      exitCode: result.exitCode,
      status: result.sandboxStatus,
    });

    return finalResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // @vercel/sandbox's APIError carries the HTTP response, JSON body,
    // and raw text — but the default Error.message is just "Status code
    // 400 is not ok", which is useless for diagnosing why the Sandbox
    // API rejected the command. Extract those fields here so the
    // workflow log shows the real cause (auth, invalid params, quota,
    // etc.).
    const apiError = error as Error & {
      response?: { status: number; statusText: string; url: string };
      json?: unknown;
      text?: string;
      sandboxId?: string;
    };
    const detail: Record<string, unknown> = {
      message,
    };
    if (apiError.sandboxId) detail.sandboxId = apiError.sandboxId;
    if (apiError.response) {
      detail.httpStatus = apiError.response.status;
      detail.httpStatusText = apiError.response.statusText;
      detail.requestUrl = apiError.response.url;
    }
    if (apiError.json) {
      const errPayload = (apiError.json as Record<string, unknown>)?.error;
      if (errPayload && typeof errPayload === 'object') {
        detail.apiError = errPayload;
      } else {
        detail.apiError = apiError.json;
      }
    } else if (typeof apiError.text === 'string' && apiError.text.trim()) {
      detail.apiResponseBody = apiError.text.trim().slice(0, 1000);
    }

    logger.error('sandbox:command_failed', {
      sessionId,
      runId,
      command: shellCommand,
      ...detail,
    });
    await patchSandboxRuntime(sessionId, {
      status: 'error',
      lastActiveAt: nowIso(),
      timeoutMs: SANDBOX_TIMEOUT_MS,
      lastCommand: shellCommand,
      lastError: message,
    });
    await writeRuntimeEvent({
      event: 'runtime-error',
      sessionId,
      runId,
      command: shellCommand,
      message,
    });
    throw error;
  }
}

async function readSandboxFileStep(
  input: ReadFileInput & {
    sessionId: string;
    runId: string;
  },
) {
  'use step';

  const { readSandboxFileAction } = await import('@/lib/core/sandbox');
  const { sessionId, runId, path, cwd } = input;

  try {
    const result = await readSandboxFileAction({ sessionId, path, cwd });
    return {
      path: result.path,
      content: result.content,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeRuntimeEvent({
      event: 'runtime-error',
      sessionId,
      runId,
      command: `readFile ${path}`,
      message,
    });
    throw error;
  }
}

async function writeSandboxFileStep(
  input: WriteFileInput & {
    sessionId: string;
    runId: string;
  },
) {
  'use step';

  const { writeSandboxFileAction } = await import('@/lib/core/sandbox');
  const { sessionId, runId, path, content, cwd } = input;

  try {
    const result = await writeSandboxFileAction({
      sessionId,
      path,
      content,
      cwd,
    });
    return {
      path: result.path,
      bytes: result.bytes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeRuntimeEvent({
      event: 'runtime-error',
      sessionId,
      runId,
      command: `writeFile ${path}`,
      message,
    });
    throw error;
  }
}

async function resolveSandboxPublicPortStep(
  input: PublicPortInput & {
    sessionId: string;
    runId: string;
  },
) {
  'use step';

  const { resolveSandboxPublicPortAction } = await import('@/lib/core/sandbox');
  const { sessionId, runId, port } = input;

  try {
    const result = await resolveSandboxPublicPortAction({ sessionId, port });
    return {
      port: result.port,
      url: result.url,
      publicPorts: result.publicPorts,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeRuntimeEvent({
      event: 'runtime-error',
      sessionId,
      runId,
      command: `openPort ${port}`,
      message,
    });
    throw error;
  }
}

async function exportSandboxFileStep(
  input: ExportFileInput & {
    sessionId: string;
    runId: string;
  },
) {
  'use step';

  const [
    { readFile: readLocalFile, rm: removeLocalFile },
    { put },
    { createFileRecord },
    { downloadSandboxFileAction },
  ] = await Promise.all([
    import('node:fs/promises'),
    import('@/lib/core/blob'),
    import('@/lib/core/db/files'),
    import('@/lib/core/sandbox'),
  ]);
  const { sessionId, runId, path, cwd } = input;

  try {
    const result = await downloadSandboxFileAction({ sessionId, path, cwd });

    const sourcePath = result.sourcePath;
    const fileName = result.fileName;
    const localPath = result.localPath;

    let url = '';
    let size = 0;

    try {
      const fileBuffer = await readLocalFile(localPath);
      size = fileBuffer.length;
      const blobPath = `sandbox-export/${sessionId}/${fileName}`;
      const blobResult = await put(blobPath, fileBuffer);
      const fileRecord = await createFileRecord({
        sessionId,
        fileName,
        sourcePath,
        size,
        mimeType: 'application/octet-stream',
        blobPath,
        blobUrl: blobResult.url,
      });
      url = `/api/files/${fileRecord.id}/download`;
    } finally {
      await removeLocalFile(localPath, {
        force: true,
        recursive: false,
      }).catch(() => undefined);
    }

    return { sourcePath, fileName, url, size };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeRuntimeEvent({
      event: 'runtime-error',
      sessionId,
      runId,
      command: `downloadFile ${path}`,
      message,
    });
    throw error;
  }
}

async function waitForSandboxApproval(input: {
  sessionId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
}): Promise<SandboxApprovalResponse> {
  'use step';

  const {
    sessionId: _sessionId,
    runId: _runId,
    toolCallId,
    toolName,
    toolInput,
  } = input;

  await writeToolApprovalRequest({
    toolCallId,
    toolName,
    toolInput,
  });

  await sendApprovalRequestReminderStep({
    source: { type: 'web' },
    toolCallId,
    toolName,
  });

  using hook = approvalHookBuilder.create({ token: toolCallId });

  let approval: SandboxApprovalResponse = { approved: false };
  for await (const payload of hook) {
    approval = payload;
    break;
  }

  if (!approval.approved) {
    await writeToolOutputDenied({
      toolCallId,
    });
  }

  return approval;
}

// ── Tool definitions ────────────────────────────────────────────────

export default defineBuildInTool({
  id: 'sandbox',
  description: `Run shell commands and read/write files inside a workspace-scoped sandbox. When Agent Daemon is online, tools are executed on Agent Daemon with full security review (L0/L1/L2) and sandbox management (docker/docker-strict/lxc). When Agent Daemon is offline, falls back to Vercel Sandbox with limited isolation.

Workspace long-lived vs short-lived containers: a workspace owns ONE long-lived LXC container that persists across tasks within a run (packages installed, files written, and environment changes survive between tool calls in the same run). If the long-lived container is busy (another run in the same workspace holds it), tool execution falls back to a short-lived ephemeral container for this turn — this ephemeral container does NOT share files or installed packages with the long-lived one, so state from earlier in the conversation may be unavailable on a busy fallback. If the workspace's preferred node goes offline, the long-lived container is reset: a fresh container is created on a healthy node and the previous rootfs state is lost (you'll be notified).`,
  factory: async (
    _config,
    { sessionId, runId, appConfig, source, workspaceLockAcquired },
  ) => {
    // CLI sessions use local_* tools (local_exec/local_read_file/
    // local_write_file) instead of the sandbox. Registering both
    // confuses the LLM and causes "Tool exec not found" when the
    // CLI host has no agentd.
    if (source?.type === 'cli') {
      return null;
    }

    const requiresApproval = appConfig.autonomy?.level === 'supervised';

    return {
      exec: tool({
        title: 'Execute Shell Command',
        description: `Execute a shell command. Agent Daemon online → full security review + docker/docker-strict/lxc sandbox. Agent Daemon offline → Vercel Sandbox (limited).`,
        inputSchema: execInputSchema,
        execute: async (input, { toolCallId }) => {
          if (requiresApproval) {
            const approval = await waitForSandboxApproval({
              sessionId,
              runId,
              toolCallId,
              toolName: 'exec',
              toolInput: input,
            });
            if (!approval.approved)
              return {
                approved: false,
                denied: true,
                reason: approval.comment,
              } satisfies SandboxDeniedOutput;
          }

          // Try Agent Daemon first
          const agentdResult = await execOnAgentd(
            sessionId,
            'exec',
            {
              command: input.command,
              args: input.args,
              cwd: input.cwd,
              env: input.env,
              sudo: input.sudo,
            },
            input.nodeId,
            workspaceLockAcquired,
          );
          if (agentdResult?.success) {
            const parsed = parseAgentdResult(agentdResult.data || '');
            return {
              kind: 'exec',
              exitCode: parsed.exitCode,
              stdout: parsed.stdout,
              stderr: parsed.stderr,
              backend: 'agentd',
              node: agentdResult.node,
            } satisfies SandboxExecOutput;
          }

          // L0 block on the agentd-online path is final: do NOT fall
          // back to Vercel Sandbox. Without this guard the block would
          // be silently bypassed because the fallback path's L0 check
          // below only fires when `agentdResult === null` (agentd
          // unreachable), not when agentd returned `{success:false}`.
          if (agentdResult?.blocked) {
            return {
              kind: 'exec',
              exitCode: 126,
              stdout: '',
              stderr: agentdResult.error ?? 'L0 rule denied',
              backend: 'agentd',
            } satisfies SandboxExecOutput;
          }

          // Fallback to Vercel Sandbox
          //
          // L0 gate: when falling back to Vercel Sandbox (agentd
          // offline), agentd's own L0 enforcement is bypassed. Re-run
          // L0 command rules here on the Web side so a block rule the
          // user configured isn't silently ignored in the degraded
          // path. Only block rules short-circuit; warn rules surface
          // but don't prevent execution.
          //
          // Rule scope: global only. The factory context exposes
          // sessionId but not agentId, and resolving sessionId→agentId
          // here would require an extra DB hit per exec. agent-scoped
          // L0 rules are a follow-up; the global set covers the
          // common case (UI defaults new rules to scope='global').
          if (agentdResult === null) {
            const { evaluateL0 } = await import('@/lib/security/l0-engine');
            const l0 = await evaluateL0('global', input.command);
            if (l0.blocked) {
              return {
                kind: 'exec',
                exitCode: 126, // "Command not executable" — POSIX-ish
                stdout: '',
                stderr: `L0 rule denied: ${l0.reason}`,
                backend: 'vercel-fallback',
              } satisfies SandboxExecOutput;
            }
          }

          const fallback = await executeSandboxCommandStep({
            sessionId,
            runId,
            ...input,
          });
          if ('cmdId' in fallback && fallback.running) {
            return {
              kind: 'running',
              shellCommand: fallback.shellCommand,
              cmdId: fallback.cmdId,
              startedAt: fallback.startedAt,
              waitTimeoutMs: fallback.waitTimeoutMs,
              message: fallback.message,
            } satisfies SandboxRunningOutput;
          }
          const execFallback = fallback as {
            exitCode: number;
            stdout: string;
            stderr: string;
          };
          return {
            kind: 'exec',
            exitCode: execFallback.exitCode,
            stdout: execFallback.stdout,
            stderr: execFallback.stderr,
            backend: 'vercel-fallback',
          } satisfies SandboxExecOutput;
        },
      }),

      readFile: tool({
        title: 'Read File',
        description: `Read a file from the sandbox. Agent Daemon online → Agent Daemon sandbox. Agent Daemon offline → Vercel Sandbox.`,
        inputSchema: readFileInputSchema,
        execute: async (input, { toolCallId }) => {
          if (requiresApproval) {
            const approval = await waitForSandboxApproval({
              sessionId,
              runId,
              toolCallId,
              toolName: 'readFile',
              toolInput: input,
            });
            if (!approval.approved)
              return {
                approved: false,
                denied: true,
                reason: approval.comment,
              } satisfies SandboxDeniedOutput;
          }

          const agentdResult = await execOnAgentd(
            sessionId,
            'read',
            {
              path: input.path,
              cwd: input.cwd,
            },
            input.nodeId,
            workspaceLockAcquired,
          );
          if (agentdResult?.success) {
            return {
              kind: 'read',
              path: input.path,
              content: agentdResult.data || '',
              backend: 'agentd',
              node: agentdResult.node,
            } satisfies SandboxReadOutput;
          }

          // L0 block is final — do not fall back to Vercel Sandbox.
          if (agentdResult?.blocked) {
            return {
              approved: false,
              denied: true,
              reason: agentdResult.error ?? 'L0 rule denied',
            } satisfies SandboxDeniedOutput;
          }

          const fallback = await readSandboxFileStep({
            sessionId,
            runId,
            ...input,
          });
          return {
            kind: 'read',
            path: fallback.path,
            content: fallback.content,
            backend: 'vercel-fallback',
          } satisfies SandboxReadOutput;
        },
      }),

      writeFile: tool({
        title: 'Write File',
        description: `Write a file into the sandbox. Agent Daemon online → Agent Daemon sandbox. Agent Daemon offline → Vercel Sandbox.`,
        inputSchema: writeFileInputSchema,
        execute: async (input, { toolCallId }) => {
          if (requiresApproval) {
            const approval = await waitForSandboxApproval({
              sessionId,
              runId,
              toolCallId,
              toolName: 'writeFile',
              toolInput: input,
            });
            if (!approval.approved)
              return {
                approved: false,
                denied: true,
                reason: approval.comment,
              } satisfies SandboxDeniedOutput;
          }

          const agentdResult = await execOnAgentd(
            sessionId,
            'write',
            {
              path: input.path,
              content: input.content,
              cwd: input.cwd,
            },
            input.nodeId,
            workspaceLockAcquired,
          );
          if (agentdResult?.success) {
            return {
              kind: 'write',
              path: input.path,
              bytes: Buffer.byteLength(input.content),
              backend: 'agentd',
              node: agentdResult.node,
            } satisfies SandboxWriteOutput;
          }

          // L0 block is final — do not fall back to Vercel Sandbox.
          if (agentdResult?.blocked) {
            return {
              approved: false,
              denied: true,
              reason: agentdResult.error ?? 'L0 rule denied',
            } satisfies SandboxDeniedOutput;
          }

          const fallback = await writeSandboxFileStep({
            sessionId,
            runId,
            ...input,
          });
          return {
            kind: 'write',
            path: fallback.path,
            bytes: fallback.bytes,
            backend: 'vercel-fallback',
          } satisfies SandboxWriteOutput;
        },
      }),

      openPort: tool({
        title: 'Resolve Public Sandbox Port URL',
        description: `Resolve a public URL from sandbox domain. Only configured ports are supported (currently: ${SANDBOX_PUBLIC_PORTS.join(', ')}).`,
        inputSchema: publicPortInputSchema,
        execute: async (input, { toolCallId }) => {
          if (requiresApproval) {
            const approval = await waitForSandboxApproval({
              sessionId,
              runId,
              toolCallId,
              toolName: 'openPort',
              toolInput: input,
            });
            if (!approval.approved)
              return {
                approved: false,
                denied: true,
                reason: approval.comment,
              } satisfies SandboxDeniedOutput;
          }

          // Port resolution is always Vercel Sandbox (Agent Daemon doesn't expose ports)
          const result = await resolveSandboxPublicPortStep({
            sessionId,
            runId,
            ...input,
          });
          return {
            kind: 'port',
            port: result.port,
            url: result.url,
            publicPorts: result.publicPorts,
            backend: 'vercel-fallback',
          } satisfies SandboxPortOutput;
        },
      }),

      downloadFile: tool({
        title: 'Export Single Sandbox File',
        description: `Export exactly one file from sandbox and return a public download URL. Directory export is not supported.`,
        inputSchema: exportFileInputSchema,
        execute: async (input, { toolCallId }) => {
          if (requiresApproval) {
            const approval = await waitForSandboxApproval({
              sessionId,
              runId,
              toolCallId,
              toolName: 'downloadFile',
              toolInput: input,
            });
            if (!approval.approved)
              return {
                approved: false,
                denied: true,
                reason: approval.comment,
              } satisfies SandboxDeniedOutput;
          }

          // File export is always Vercel Sandbox
          const result = await exportSandboxFileStep({
            sessionId,
            runId,
            ...input,
          });
          return {
            kind: 'export',
            sourcePath: result.sourcePath,
            fileName: result.fileName,
            url: result.url,
            size: result.size,
            backend: 'vercel-fallback',
          } satisfies SandboxExportOutput;
        },
      }),
    };
  },
});
