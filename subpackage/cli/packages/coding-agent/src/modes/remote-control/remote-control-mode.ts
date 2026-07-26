/**
 * Remote control mode: headless CLI that can be controlled from IM/Web.
 *
 * Similar to RPC mode but designed for Web backend orchestration:
 * - Connects to Web backend via SSE (/api/cli/session-events/[sessionId])
 * - Receives tool requests as events
 * - Executes tools locally (file ops, shell, computer_use)
 * - Posts results back to Web (/api/cli/sessions/[sessionId]/tool-result)
 * - Heartbeat keeps the connection alive (renews KV online state)
 */

import { EventSourceParserStream } from 'eventsource-parser/stream';
import chalk from 'chalk';
import { getStoredAuth } from '@agentboster/adapter';
import { createLogger } from '../../utils/logger.ts';
import { getBackendUrl } from '../../core/backend-url.ts';
import { detectLocalCapabilities } from '../../core/capability-detect.ts';
import {
  generateCliSessionId,
  startCliSessionRegistrar,
  type RegistrarHandle,
} from '../../core/cli-session-registrar.ts';
import { collectLocalMcpServersForRegistrar } from '../../cli/local-mcp-collector.ts';
import { startMcpServer, stopMcpServer } from './mcp-client.ts';
import { RemoteControlLock } from '../../core/remote-control-lock.ts';

const logger = createLogger('remote-control');
const remoteControlLock = new RemoteControlLock();

export interface RemoteControlModeOptions {
  sessionId?: string;
}

interface ToolRequest {
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  runId?: string;
  sessionId?: string;
}

interface ToolResult {
  ok: boolean;
  output?: unknown;
  error?: string;
}

/**
 * Run remote control mode: connect to Web backend and wait for tool requests.
 */
export async function runRemoteControlMode(
  options: RemoteControlModeOptions,
): Promise<never> {
  const auth = getStoredAuth();
  if (!auth) {
    throw new Error('Not authenticated');
  }

  const backendUrl = getBackendUrl();
  const sessionId = options.sessionId || generateCliSessionId();

  console.log(chalk.cyan('Remote control mode started'));
  console.log(chalk.dim(`Session ID: ${sessionId}`));
  console.log(chalk.dim(`Backend: ${backendUrl}`));

  // Detect local capabilities and show guidance
  const capabilities = detectLocalCapabilities();
  if (capabilities.issues.length > 0) {
    console.log();
    for (const issue of capabilities.issues) {
      console.log(chalk.yellow(`  ! ${issue}`));
    }
  }

  const availableTools = [
    'local_read_file',
    'local_write_file',
    'local_exec',
    'local_grep',
  ];

  // Try to start MCP server for computer-use tools
  let mcpStarted = false;
  if (capabilities.hasMcpBinary && capabilities.hasDisplay) {
    try {
      await startMcpServer(sessionId);
      mcpStarted = true;
      availableTools.push(
        'screenshot',
        'mouse_move',
        'mouse_click',
        'mouse_drag',
        'key_event',
        'type_text',
        'get_accessibility_tree',
        'get_focused_element',
      );
      console.log(chalk.green('✓ Computer-use tools enabled'));
    } catch (error) {
      logger.error('Failed to start MCP server', { error });
      console.log(
        chalk.yellow(
          '  ! Computer-use tools unavailable (MCP server failed to start)',
        ),
      );
    }
  }

  console.log();
  console.log(
    chalk.green('Waiting for commands from IM/Web... (Press Ctrl+C to exit)'),
  );

  // Register this CLI as online + keep KV TTL fresh. The registrar owns
  // the heartbeat interval and the release POST on shutdown.
  // Collect local MCP servers once at startup — discovery hits the
  // filesystem and we don't want to repeat it on every 30s heartbeat.
  // The registrar re-sends the same list each heartbeat (the Web re-reads
  // its allowlist fresh, so an admin enabling a server mid-session takes
  // effect on the next heartbeat without a CLI restart).
  const localMcpServers = await collectLocalMcpServersForRegistrar(
    process.cwd(),
  );
  const registrar: RegistrarHandle = await startCliSessionRegistrar({
    backendUrl,
    token: auth.token,
    sessionId,
    tools: availableTools,
    capabilities,
    cwd: process.cwd(),
    mcpServers: localMcpServers,
  });

  // Connect to SSE stream
  const sseUrl = `${backendUrl}/api/cli/session-events/${sessionId}`;
  logger.info('Connecting to SSE', { sseUrl });

  const controller = new AbortController();
  // Trigger cleanup for every termination signal we can intercept.
  // SIGINT (Ctrl+C), SIGTERM (default `kill` / container stop), and
  // SIGHUP (terminal closed) all need to flush registrar.release() and
  // stopMcpServer() — otherwise the Web backend holds a stale online
  // capability entry until the 120s KV TTL expires and the MCP child
  // process leaks until the OS reaps it.
  //
  // Bounded forced-exit: abort() asks in-flight tools to stop, but a
  // tool that ignores its AbortSignal (or a stuck MCP call) could
  // otherwise hold the process hostage. After GRACE_PERIOD_MS we
  // unconditionally process.exit so the OS reaps children.
  const GRACE_PERIOD_MS = 5_000;
  let forceExitTimer: NodeJS.Timeout | null = null;
  const shutdownSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const signalHandlers = new Map<NodeJS.Signals, NodeJS.SignalsListener>();
  for (const sig of shutdownSignals) {
    const handler = () => {
      console.log(chalk.yellow(`\nReceived ${sig}, shutting down...`));
      controller.abort();
      // Only arm the forced-exit timer once, even if multiple signals
      // arrive in succession.
      if (!forceExitTimer) {
        forceExitTimer = setTimeout(() => {
          console.error(
            chalk.red(
              `Grace period expired after ${GRACE_PERIOD_MS}ms, forcing exit`,
            ),
          );
          process.exit(128 + 15); // SIGTERM convention
        }, GRACE_PERIOD_MS).unref();
      }
    };
    process.on(sig, handler);
    signalHandlers.set(sig, handler);
  }

  try {
    while (true) {
      try {
        const response = await fetch(sseUrl, {
          headers: {
            Authorization: `Bearer ${auth.token}`,
            Accept: 'text/event-stream',
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(
            `SSE connection failed: ${response.status} ${response.statusText}`,
          );
        }

        if (!response.body) {
          throw new Error('Response body is null');
        }

        const stream = response.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new EventSourceParserStream());

        // Manual reader loop instead of `for await ... of stream` —
        // coding-agent's tsconfig lib config doesn't declare
        // ReadableStream's asyncIterator, so the for-await form fails
        // tsgo/tsc even though it works at runtime. Mirrors the same
        // workaround in cli-session-registrar.ts.
        const reader = stream.getReader();
        while (true) {
          if (controller.signal.aborted) break;
          const { value: event, done } = await reader.read();
          if (done) break;
          if (!event) continue;
          if (event.event === 'tool-request') {
            const request: ToolRequest = JSON.parse(event.data);
            logger.info('Received tool request', {
              toolName: request.toolName,
            });
            console.log(chalk.blue(`→ Executing: ${request.toolName}`));

            // Execute tool. Pass the abort signal so termination
            // signals can interrupt in-flight tools.
            const result = await executeLocalTool(request, controller.signal);

            // Post result back
            await postToolResult(
              backendUrl,
              auth.token,
              sessionId,
              request.toolCallId,
              result,
            );

            console.log(chalk.green(`✓ Completed: ${request.toolName}`));
          } else if (event.event === 'heartbeat') {
            logger.debug('Heartbeat received');
          } else if (event.event === 'lock-acquired') {
            const lockData = JSON.parse(event.data);
            logger.info('Remote workflow started, acquiring lock', {
              runId: lockData.runId,
            });
            remoteControlLock.acquire();
            console.log(
              chalk.yellow(
                '🔒 Remote Control Active — session locked by IM workflow',
              ),
            );
          } else if (event.event === 'lock-released') {
            const lockData = JSON.parse(event.data);
            logger.info('Remote workflow completed, releasing lock', {
              runId: lockData.runId,
            });
            remoteControlLock.release();
            console.log(
              chalk.green('🔓 Remote Control Released — session unlocked'),
            );
          }
        }
      } catch (error: unknown) {
        if (controller.signal.aborted) {
          break;
        }
        logger.error('SSE stream error, reconnecting...', { error });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  } finally {
    for (const [sig, handler] of signalHandlers) {
      process.off(sig, handler);
    }
    await registrar.stop();
    if (mcpStarted) {
      await stopMcpServer();
    }
    // Clean exit — disarm the forced-exit timer so it doesn't fire
    // after the finally block completes.
    if (forceExitTimer) {
      clearTimeout(forceExitTimer);
      forceExitTimer = null;
    }
  }

  process.exit(0);
}

async function executeLocalTool(
  request: ToolRequest,
  signal?: AbortSignal,
): Promise<ToolResult> {
  try {
    // Import tool executors dynamically to avoid loading heavy deps in main bundle
    const { executeLocalTool: exec } = await import('./tool-executor.ts');
    // Remote-control mode has no interactive approver; pass auth so the
    // L0/L1 gate runs, but any L2-confirm is rejected fail-closed.
    // Pass the AbortController's signal so SIGTERM/SIGINT/SIGHUP can
    // interrupt a long-running local_exec / MCP call instead of
    // blocking shutdown until the tool's own timeout expires.
    const output = await exec(request.toolName, request.toolInput, {
      auth: getStoredAuth(),
      signal,
    });
    return { ok: true, output };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function postToolResult(
  backendUrl: string,
  token: string,
  sessionId: string,
  toolCallId: string,
  result: ToolResult,
): Promise<void> {
  // Bounded retry. Idempotent on toolCallId so re-POSTing is safe.
  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = [0, 500, 2_000];
  const REQUEST_TIMEOUT_MS = 8_000;
  const url = `${backendUrl}/api/cli/tool-result`;
  const body = JSON.stringify({
    sessionId,
    toolCallId,
    ok: result.ok,
    output: result.output,
    error: result.error,
  });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (BACKOFF_MS[attempt]) {
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
    }
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return;
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      ) {
        logger.error('tool-result POST permanently rejected', {
          status: response.status,
          toolCallId,
        });
        return;
      }
      logger.warn('tool-result POST failed, retrying', {
        status: response.status,
        attempt,
        toolCallId,
      });
    } catch (error) {
      logger.warn('tool-result POST threw, retrying', {
        attempt,
        toolCallId,
        error,
      });
    }
  }
  logger.error('tool-result POST exhausted retries', { toolCallId });
}
