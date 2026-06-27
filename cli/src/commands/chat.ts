import { randomUUID } from 'node:crypto';
import { ensureConfig, getActiveDeployment, loadConfig } from '../lib/config';
import { createStreamFetcher } from '../lib/api';
import { readSseStream, type UiMessageChunk } from '../lib/sse';

/**
 * Print-only chat command. Sends a single user message to /api/cli/chat
 * and prints the streaming response to stdout. No TUI yet (that's the
 * next stage).
 *
 * This exists as the minimum-viable end-to-end proof: login → POST →
 * SSE → tokens on the terminal. Once the TUI is in place, the
 * streaming logic here gets reused verbatim.
 */
export async function chatCommand(options: {
  message?: string;
  sessionId?: string;
  deployment?: string;
}): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error(
      'Not logged in. Run `agentboster login --url <your-web-url>` first.',
    );
    process.exit(1);
  }

  const ensure = ensureConfig();
  const active = getActiveDeployment(ensure, options.deployment);
  if (!active) {
    console.error(
      'No configured deployment. Run `agentboster login --url <your-web-url>` first.',
    );
    process.exit(1);
  }

  let message = options.message;
  if (!message) {
    // Read from stdin if no inline message.
    const stdin = await readStdin();
    message = stdin.trim();
  }
  if (!message) {
    console.error('Error: a message is required (pass as arg or via stdin).');
    process.exit(1);
  }

  const sessionId = options.sessionId ?? randomUUID();
  const streamFetch = createStreamFetcher(active.deployment);

  const response = await streamFetch('/api/cli/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({
      id: sessionId,
      trigger: 'submit-message',
      input: { text: message },
      clientId: ensure.clientId,
      label: ensure.label,
    }),
  });

  if (!response.ok) {
    let errorText = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as {
        error?: string;
        message?: string;
      };
      errorText = body.message ?? body.error ?? errorText;
    } catch {
      // ignore parse failure
    }
    console.error(`Request failed: ${errorText}`);
    process.exit(1);
  }

  const newSessionId = response.headers.get('x-session-id') ?? sessionId;
  const runId = response.headers.get('x-workflow-run-id');
  process.stderr.write(
    `[session: ${newSessionId}${runId ? ` | run: ${runId}` : ''}]\n`,
  );

  try {
    for await (const chunk of readSseStream(response)) {
      printChunk(chunk);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`\nStream error: ${msg}`);
    process.exit(1);
  }
}

function printChunk(chunk: UiMessageChunk): void {
  if (chunk.type === 'text-delta') {
    const delta = (chunk as { delta?: string }).delta;
    if (typeof delta === 'string') {
      process.stdout.write(delta);
    }
    return;
  }

  if (chunk.type === 'error') {
    const text = (chunk as { errorText?: string }).errorText;
    if (text) process.stderr.write(`\n[error] ${text}\n`);
    return;
  }

  if (chunk.type === 'data-workflow') {
    const data = (chunk as { data?: { kind: string; type: string } }).data;
    if (data?.kind === 'status' && data.type === 'local-tool-request') {
      // Stage D will execute these; for now just log that one was received.
      const req = chunk as unknown as {
        data: {
          toolCallId: string;
          toolName: string;
          toolInput: unknown;
        };
      };
      process.stderr.write(
        `\n[local-tool-request] ${req.data.toolName} (call ${req.data.toolCallId.slice(0, 8)}…) — not executed (stage D pending)\n`,
      );
    }
    return;
  }

  // Other chunk types (tool-input-*, tool-output-*, message-metadata,
  // step-finish, etc.) are ignored in print mode — they matter for the
  // TUI but not for streaming tokens to stdout.
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });
}
