/**
 * CLI Session Registrar — keeps the Web backend informed that a CLI is
 * online for a given session and what capabilities it has.
 *
 * Both `remote-control` mode (standalone CLI controlled from IM/Web) and
 * `rpc` mode (CLI embedded inside Desktop) need to:
 *   1. POST /api/cli/session-events/[sessionId]/register once on startup,
 *      declaring capabilities + available tools. This writes the
 *      `cli-remote:<sessionId>` KV entry that `getCliCapabilities` reads.
 *   2. Re-register on a 30s heartbeat to refresh the KV TTL (120s) —
 *      otherwise Web starts treating the CLI as offline and tool
 *      providers like `computer-use-remote` de-register.
 *   3. POST .../release on shutdown so Web marks the session offline
 *      promptly instead of waiting for the KV TTL.
 *
 * This module is a pure helper — it does not decide which tools to
 * advertise, nor does it own the SSE listener for incoming tool-request
 * events. Callers compose it.
 */

import { createLogger } from '../utils/logger.ts';
import type { LocalCapabilities } from './capability-detect.ts';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { randomUUID } from 'node:crypto';

const logger = createLogger('cli-session-registrar');

const HEARTBEAT_INTERVAL_MS = 30_000;

export interface RegistrarCapabilitiesView {
  hasDisplay: boolean;
  platform: string;
  isAdmin: boolean;
  scaleFactor: number;
}

export interface RegistrarStartOptions {
  backendUrl: string;
  token: string;
  sessionId: string;
  tools: string[];
  capabilities: LocalCapabilities;
  /** cwd to advertise (Web shows it in the session UI). */
  cwd?: string;
}

export interface RegistrarHandle {
  /** Stop the heartbeat and POST /release. Safe to call multiple times. */
  stop: () => Promise<void>;
}

/**
 * Start the registrar: POST /register immediately, then every
 * HEARTBEAT_INTERVAL_MS re-POST to refresh the KV TTL.
 *
 * Returns a handle whose `stop()` clears the interval and POSTs /release.
 * Callers should wire `stop()` into every process-shutdown path
 * (SIGINT, SIGTERM, stdin close, normal exit).
 */
export async function startCliSessionRegistrar(
  options: RegistrarStartOptions,
): Promise<RegistrarHandle> {
  const { backendUrl, token, sessionId, tools, capabilities } = options;
  const cwd = options.cwd ?? process.cwd();

  const capabilitiesView: RegistrarCapabilitiesView = {
    hasDisplay: capabilities.hasDisplay,
    platform: capabilities.platform,
    isAdmin: capabilities.isAdmin,
    scaleFactor: capabilities.scaleFactor,
  };

  const body = JSON.stringify({
    capabilities: capabilitiesView,
    tools,
    cwd,
  });

  let stopped = false;
  // Tracks the in-flight register fetch so the heartbeat never overlaps
  // a previous slow request (e.g. hung TCP connection). `unref`-friendly
  // because we `await` it before issuing the next beat.
  let inflight: Promise<void> | null = null;
  const REQUEST_TIMEOUT_MS = 8_000;

  const doRegister = async (): Promise<void> => {
    if (stopped) return;
    if (inflight) {
      // Previous beat still running — skip rather than queue. Next
      // interval tick will retry. Avoids the "every 30s a new request
      // piles up on a hung socket" failure mode.
      logger.warn('Skipped heartbeat: previous register still in flight', {
        sessionId,
      });
      return;
    }
    inflight = (async () => {
      try {
        const response = await fetch(
          `${backendUrl}/api/cli/session-events/${sessionId}/register`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          },
        );
        if (!response.ok) {
          logger.warn('Register failed', {
            sessionId,
            status: response.status,
            statusText: response.statusText,
          });
        }
      } catch (error) {
        // Heartbeat is best-effort; the KV TTL is the real source of truth
        // and a brief network blip won't take the session offline (TTL=120s,
        // heartbeat=30s, so 3 missed heartbeats are tolerable).
        logger.warn('Register request threw', { sessionId, error });
      } finally {
        inflight = null;
      }
    })();
    await inflight;
  };

  // Initial registration.
  await doRegister();
  logger.info('Registrar started', { sessionId, tools });

  const interval = setInterval(() => {
    void doRegister();
  }, HEARTBEAT_INTERVAL_MS);

  // Don't keep the event loop alive just for heartbeats — callers own
  // the process lifecycle.
  if (typeof interval.unref === 'function') {
    interval.unref();
  }

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    try {
      const response = await fetch(
        `${backendUrl}/api/cli/session-events/${sessionId}/release`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        logger.warn('Release failed', {
          sessionId,
          status: response.status,
          statusText: response.statusText,
        });
        return;
      }
      logger.info('Registrar released', { sessionId });
    } catch (error) {
      logger.warn('Release request threw', { sessionId, error });
    }
  };

  return { stop };
}

/**
 * Generate a stable CLI session id. Same format as the legacy
 * remote-control-mode's generateSessionId(), so Web doesn't need to
 * distinguish "Desktop-spawned" sessions from "standalone CLI" sessions.
 */
export function generateCliSessionId(): string {
  return `cli-${Date.now()}-${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Session-event SSE stream (incoming tool-request from Web)
// ---------------------------------------------------------------------------

export interface SessionToolRequest {
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  runId?: string;
  sessionId?: string;
}

export interface SessionEventStreamHandle {
  /** Stop the SSE connection loop. Safe to call multiple times. */
  stop: () => Promise<void>;
}

/**
 * Connect to `/api/cli/session-events/[sessionId]` and dispatch
 * `tool-request` events to `onToolRequest`. Reconnects with backoff on
 * transient errors. Returns a handle that stops the loop.
 *
 * Used by RPC mode (when launched with --backend-url + --session-id) so
 * Web-initiated tool calls can reach a CLI that Desktop spawned — the
 * CLI is simultaneously serving Desktop over stdio AND listening for
 * remote tool-request events over this SSE stream.
 *
 * For `remote-control` mode the same effect is achieved inline because
 * that mode has no other primary work loop; this helper exists to keep
 * RPC mode's primary stdin loop untouched.
 */
export async function connectSessionEventStream(params: {
  backendUrl: string;
  token: string;
  sessionId: string;
  onToolRequest: (request: SessionToolRequest) => Promise<void>;
}): Promise<SessionEventStreamHandle> {
  const { backendUrl, token, sessionId, onToolRequest } = params;
  const logger = createLogger('cli-session-stream');

  const controller = new AbortController();
  let stopped = false;

  const sseUrl = `${backendUrl}/api/cli/session-events/${sessionId}`;

  // Loop in the background. We don't await it; the handle's stop()
  // aborts the controller which breaks the loop.
  void (async () => {
    while (!stopped) {
      try {
        const response = await fetch(sseUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'text/event-stream',
          },
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(
            `SSE connection failed: ${response.status} ${response.statusText}`,
          );
        }

        const stream = response.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new EventSourceParserStream());

        // Manual reader loop instead of `for await ... of stream` —
        // coding-agent's tsconfig lib config doesn't declare
        // ReadableStream's asyncIterator, so the for-await form fails
        // tsc even though it works at runtime.
        const reader = stream.getReader();
        while (!stopped) {
          const { value: event, done } = await reader.read();
          if (done || stopped) break;
          if (!event) continue;
          if (event.event === 'tool-request') {
            try {
              const request: SessionToolRequest = JSON.parse(event.data);
              await onToolRequest(request);
            } catch (error) {
              logger.warn('Failed to handle tool-request event', { error });
            }
          }
          // heartbeat / lock-acquired / lock-released events are ignored
          // here: RPC mode doesn't acquire the RemoteControlLock because
          // the Desktop embedder (not the CLI) is the primary chat host.
        }
      } catch (error: unknown) {
        if (stopped || controller.signal.aborted) break;
        logger.warn('SSE stream error, reconnecting', { error });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  })();

  return {
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      controller.abort();
    },
  };
}
