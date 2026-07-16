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

const logger = createLogger('remote-control');

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
  const sessionId = options.sessionId || generateSessionId();

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
  if (capabilities.hasMcpBinary && capabilities.hasDisplay) {
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
  }

  console.log();
  console.log(
    chalk.green(
      'Waiting for commands from IM/Web... (Press Ctrl+C to exit)',
    ),
  );

  // Register this CLI as online
  await registerCliNode(backendUrl, auth.token, sessionId);

  // Connect to SSE stream
  const sseUrl = `${backendUrl}/api/cli/session-events/${sessionId}`;
  logger.info('Connecting to SSE', { sseUrl });

  const controller = new AbortController();
  process.on('SIGINT', () => {
    console.log(chalk.yellow('\nShutting down...'));
    controller.abort();
  });

  // Heartbeat interval (every 30s)
  const heartbeatInterval = setInterval(async () => {
    try {
      await fetch(`${backendUrl}/api/cli/session-events/${sessionId}/register`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          capabilities: {
            hasDisplay: capabilities.hasDisplay,
            platform: capabilities.platform,
            isAdmin: capabilities.isAdmin,
            scaleFactor: capabilities.scaleFactor,
          },
          tools: availableTools,
          cwd: process.cwd(),
        }),
      });
    } catch (error) {
      logger.warn('Heartbeat failed', { error });
    }
  }, 30000);

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
          throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
        }

        if (!response.body) {
          throw new Error('Response body is null');
        }

        const stream = response.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new EventSourceParserStream());

        for await (const event of stream) {
          if (event.type === 'event') {
            if (event.event === 'tool-request') {
              const request: ToolRequest = JSON.parse(event.data);
              logger.info('Received tool request', { toolName: request.toolName });
              console.log(chalk.blue(`→ Executing: ${request.toolName}`));

              // Execute tool
              const result = await executeLocalTool(request);

              // Post result back
              await postToolResult(backendUrl, auth.token, sessionId, request.toolCallId, result);

              console.log(chalk.green(`✓ Completed: ${request.toolName}`));
            } else if (event.event === 'heartbeat') {
              logger.debug('Heartbeat received');
            }
          }
        }
      } catch (error: unknown) {
        if (controller.signal.aborted) {
          break;
        }
        logger.error('SSE stream error, reconnecting...', { error });
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  } finally {
    clearInterval(heartbeatInterval);
    await releaseCliNode(backendUrl, auth.token, sessionId);
  }

  process.exit(0);
}

async function registerCliNode(
  backendUrl: string,
  token: string,
  sessionId: string,
): Promise<void> {
  const response = await fetch(
    `${backendUrl}/api/cli/session-events/${sessionId}/register`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        capabilities: {
          hasDisplay: process.platform !== 'linux' || !!process.env.DISPLAY,
          platform: process.platform,
          isAdmin: process.getuid?.() === 0,
          scaleFactor: 1,
        },
        tools: ['local_read_file', 'local_write_file', 'local_exec', 'local_grep'],
        cwd: process.cwd(),
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to register: ${response.status} ${response.statusText}`);
  }

  logger.info('Registered as online', { sessionId });
}

async function releaseCliNode(
  backendUrl: string,
  token: string,
  sessionId: string,
): Promise<void> {
  try {
    await fetch(
      `${backendUrl}/api/cli/session-events/${sessionId}/release`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );
    logger.info('Released online state', { sessionId });
  } catch (error) {
    logger.warn('Failed to release', { error });
  }
}

async function executeLocalTool(request: ToolRequest): Promise<ToolResult> {
  try {
    // Import tool executors dynamically to avoid loading heavy deps in main bundle
    const { executeLocalTool: exec } = await import('./tool-executor.ts');
    const output = await exec(request.toolName, request.toolInput);
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
  const response = await fetch(
    `${backendUrl}/api/ai/${sessionId}/tool-result`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        toolCallId,
        result,
      }),
    },
  );

  if (!response.ok) {
    logger.warn('Failed to post tool result', {
      status: response.status,
      statusText: response.statusText,
    });
  }
}

function generateSessionId(): string {
  return `cli-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
