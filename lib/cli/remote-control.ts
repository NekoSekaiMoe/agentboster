import { get, set, del, expire } from '@/lib/core/kv';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('cli-remote-control');

// ---------------------------------------------------------------------------
// In-process listener registry
// ---------------------------------------------------------------------------

interface CliListener {
  send: (event: string, data: unknown) => void;
  sessionId: string;
  connectedAt: number;
}

const listeners = new Map<string, CliListener>();

export function registerCliListener(
  sessionId: string,
  listener: CliListener,
): void {
  const old = listeners.get(sessionId);
  if (old) {
    logger.info('Replacing existing CLI listener', { sessionId });
  }
  listeners.set(sessionId, listener);
}

export function unregisterCliListener(sessionId: string): void {
  listeners.delete(sessionId);
}

export function getCliListener(sessionId: string): CliListener | null {
  return listeners.get(sessionId) ?? null;
}

/**
 * Push an event to the CLI's persistent SSE connection for a session.
 * Returns true if the event was delivered via the in-process listener.
 */
export async function pushToCliSession(
  sessionId: string,
  event: string,
  data: unknown,
): Promise<boolean> {
  const listener = listeners.get(sessionId);
  if (listener) {
    listener.send(event, data);
    return true;
  }

  // Vercel serverless fallback: write to KV for the SSE endpoint to poll.
  // Uses a simple counter-based queue since lpush/rpop are not available.
  try {
    const queueKey = `cli-events:${sessionId}`;
    const counterKey = `cli-events-ctr:${sessionId}`;
    const raw = await get(counterKey);
    const counter = typeof raw === 'string' ? parseInt(raw, 10) + 1 : 1;
    await set(`${queueKey}:${counter}`, JSON.stringify({ event, data }), {
      ex: 300,
    });
    await set(counterKey, String(counter), { ex: 300 });
  } catch {
    // best-effort
  }

  return false;
}

/**
 * Drain queued events from KV (Vercel serverless fallback).
 * Called by the SSE endpoint's poll loop.
 */
export async function drainKvEvents(
  sessionId: string,
): Promise<Array<{ event: string; data: unknown }>> {
  const counterKey = `cli-events-ctr:${sessionId}`;
  const lastReadKey = `cli-events-read:${sessionId}`;
  const results: Array<{ event: string; data: unknown }> = [];

  try {
    const counterRaw = await get(counterKey);
    const lastReadRaw = await get(lastReadKey);
    const counter =
      typeof counterRaw === 'string' ? parseInt(counterRaw, 10) : 0;
    const lastRead =
      typeof lastReadRaw === 'string' ? parseInt(lastReadRaw, 10) : 0;

    if (counter <= lastRead) return results;

    const queueKey = `cli-events:${sessionId}`;
    for (let i = lastRead + 1; i <= counter; i++) {
      const raw = await get(`${queueKey}:${i}`);
      if (typeof raw === 'string') {
        try {
          results.push(JSON.parse(raw));
        } catch {
          // skip malformed entries
        }
        await del(`${queueKey}:${i}`);
      }
    }

    await set(lastReadKey, String(counter), { ex: 300 });
  } catch {
    // best-effort
  }

  return results;
}

// ---------------------------------------------------------------------------
// KV online state
// ---------------------------------------------------------------------------

export interface CliRemoteState {
  online: boolean;
  tools: string[];
  capabilities: {
    hasDisplay: boolean;
    platform: string;
    isAdmin: boolean;
    scaleFactor: number;
  };
  connectedAt: number;
  cwd?: string;
  /**
   * MCP servers reachable from the attached CLI / desktop, reported by the
   * desktop renderer via /api/cli/session-events/:sessionId/register. Each
   * entry is a stdio command the desktop host is willing to spawn on
   * behalf of the agent. Workflow tool registration reads this list and,
   * for each server the Web allows, registers its tools as remote-call
   * tools dispatched back through the CLI SSE channel (same pattern as
   * computer-use-remote).
   *
   * Empty when the desktop has no MCP servers configured, or when the
   * connected client is a bare CLI (no desktop) — the field is optional
   * so older clients that never set it stay forward-compatible.
   */
  mcpServers?: CliRemoteMcpServer[];
}

/**
 * A single MCP server reported by the desktop. The Web does NOT trust the
 * `command` blindly — it cross-references against its own allowlist (admin-
 * configured) before registering tools, so a malicious / naive desktop can't
 * surface arbitrary local binaries to the model.
 */
export interface CliRemoteMcpServer {
  /** Stable name (matches the desktop's mcp config key). */
  name: string;
  /** Executable + args the desktop would spawn, e.g. ["npx", "-y", ...]. */
  command: string[];
  /** Optional env vars the desktop would set. Reported for visibility; the
   * Web never re-spawns the server itself, it only tells the desktop to. */
  env?: Record<string, string>;
  /** Transport the server speaks. stdio is the only one the desktop proxies. */
  transport: 'stdio';
}

const KV_TTL_SECONDS = 120;

export async function markCliOnline(
  sessionId: string,
  state?: Partial<CliRemoteState>,
): Promise<void> {
  const value: CliRemoteState = {
    online: true,
    tools: state?.tools ?? [],
    capabilities: state?.capabilities ?? {
      hasDisplay: false,
      platform: 'unknown',
      isAdmin: false,
      scaleFactor: 1,
    },
    connectedAt: state?.connectedAt ?? Date.now(),
    cwd: state?.cwd,
    mcpServers: state?.mcpServers,
  };
  await set(`cli-remote:${sessionId}`, JSON.stringify(value), {
    ex: KV_TTL_SECONDS,
  });
}

export async function markCliOffline(sessionId: string): Promise<void> {
  await del(`cli-remote:${sessionId}`);
  logger.info('CLI marked offline', { sessionId });
}

export async function renewCliHeartbeat(sessionId: string): Promise<void> {
  await expire(`cli-remote:${sessionId}`, KV_TTL_SECONDS);
}

export async function isCliOnlineForSession(
  sessionId: string,
): Promise<boolean> {
  const raw = await get(`cli-remote:${sessionId}`);
  if (!raw) return false;
  try {
    const state: CliRemoteState = JSON.parse(raw as string);
    return state.online;
  } catch {
    return false;
  }
}

export async function getCliCapabilities(
  sessionId: string,
): Promise<CliRemoteState | null> {
  const raw = await get(`cli-remote:${sessionId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw as string) as CliRemoteState;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// IM attachment bindings
// ---------------------------------------------------------------------------

export async function setImAttachment(
  adapter: string,
  threadId: string,
  sessionId: string,
): Promise<void> {
  await set(`im-attach:${adapter}:${threadId}`, sessionId);
  await set(
    `cli-im-binding:${sessionId}`,
    JSON.stringify({ adapter, threadId }),
  );
}

export async function clearImAttachment(
  adapter: string,
  threadId: string,
): Promise<void> {
  const sessionId = await get(`im-attach:${adapter}:${threadId}`);
  if (sessionId) {
    await del(`im-attach:${adapter}:${threadId}`);
    await del(`cli-im-binding:${sessionId as string}`);
  }
}

export async function getAttachedSessionId(
  adapter: string,
  threadId: string,
): Promise<string | null> {
  const raw = await get(`im-attach:${adapter}:${threadId}`);
  return typeof raw === 'string' ? raw : null;
}

export async function getImBinding(
  sessionId: string,
): Promise<{ adapter: string; threadId: string } | null> {
  const raw = await get(`cli-im-binding:${sessionId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw as string);
  } catch {
    return null;
  }
}

/**
 * Handle CLI session switch: migrate IM binding from old to new session.
 */
export async function handleCliSessionSwitch(
  oldSessionId: string,
  newSessionId: string,
): Promise<{ adapter: string; threadId: string } | null> {
  const binding = await getImBinding(oldSessionId);
  if (!binding) return null;

  await del(`im-attach:${binding.adapter}:${binding.threadId}`);
  await del(`cli-im-binding:${oldSessionId}`);

  await set(`im-attach:${binding.adapter}:${binding.threadId}`, newSessionId);
  await set(`cli-im-binding:${newSessionId}`, JSON.stringify(binding));

  logger.info('Migrated IM binding on session switch', {
    oldSessionId,
    newSessionId,
    adapter: binding.adapter,
  });

  return binding;
}

// ---------------------------------------------------------------------------
// Session lock (per-workflow-run)
// ---------------------------------------------------------------------------

const LOCK_TTL_SECONDS = 600;

export async function acquireSessionLock(
  sessionId: string,
  runId: string,
): Promise<boolean> {
  const result = await set(
    `cli-lock:${sessionId}`,
    JSON.stringify({ runId, lockedAt: Date.now() }),
    { nx: true, ex: LOCK_TTL_SECONDS },
  );
  if (result !== 'OK') {
    return false;
  }
  await pushToCliSession(sessionId, 'lock-acquired', {
    runId,
    source: 'im',
  });
  return true;
}

export async function releaseSessionLock(
  sessionId: string,
  runId: string,
): Promise<void> {
  const raw = await get(`cli-lock:${sessionId}`);
  if (raw) {
    const lock = JSON.parse(raw as string);
    if (lock.runId !== runId) {
      return;
    }
  }
  await del(`cli-lock:${sessionId}`);
  await pushToCliSession(sessionId, 'lock-released', { runId });
}
