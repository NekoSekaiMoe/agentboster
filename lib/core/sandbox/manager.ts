import { getSession, updateSession } from '@/lib/core/db/chat';
import { withKvLock } from '@/lib/core/kv/lock';
import { createLogger } from '@/lib/utils/logger';
import { Sandbox } from '@vercel/sandbox';
import {
  SANDBOX_DIRS,
  SANDBOX_PUBLIC_PORTS,
  SANDBOX_TIMEOUT_MS,
  SANDBOX_WORKSPACE_DIR,
  type SandboxRuntimeState,
  getSessionRuntimeMetadata,
  nowIso,
  patchSandboxRuntime,
} from './runtime';

const logger = createLogger('sandbox.manager');
const SANDBOX_NETWORK_POLICY = 'allow-all' as const;
const SANDBOX_RUNTIME = 'node24' as const;
const SANDBOX_TIMEOUT_RENEW_THRESHOLD_MS = 5 * 60 * 1000;
const SANDBOX_TIMEOUT_RENEW_INCREMENT_MS = 5 * 60 * 1000;
const SESSION_SANDBOX_LOCK_TTL_MS = SANDBOX_TIMEOUT_MS + 30_000;
const SESSION_SANDBOX_LOCK_WAIT_MS = 15_000;
const SESSION_SANDBOX_LOCK_POLL_MS = 250;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function truncateForLog(value: string, maxLength = 500): string {
  if (value.length <= maxLength) {
    return value;
  }

  const removedCount = value.length - maxLength;
  return `${value.slice(
    0,
    maxLength,
  )}...[truncated ${removedCount} characters]`;
}

function getSandboxErrorLogContext(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return {
      errorMessage: String(error),
    };
  }

  const sandboxError = error as Error & {
    response?: {
      status: number;
      statusText: string;
      url: string;
      headers?: {
        get(name: string): string | null;
      };
    };
    json?: unknown;
    text?: string;
    sandboxId?: string;
  };

  const context: Record<string, unknown> = {
    errorName: sandboxError.name,
    errorMessage: sandboxError.message,
  };

  if (sandboxError.sandboxId) {
    context.sandboxId = sandboxError.sandboxId;
  }

  if (sandboxError.response) {
    context.httpStatus = sandboxError.response.status;
    context.httpStatusText = sandboxError.response.statusText;
    context.requestUrl = sandboxError.response.url;

    const requestId =
      sandboxError.response.headers?.get('x-vercel-id') ??
      sandboxError.response.headers?.get('x-request-id');
    if (requestId) {
      context.requestId = requestId;
    }
  }

  const errorPayload = asRecord(asRecord(sandboxError.json).error);
  if (typeof errorPayload.code === 'string') {
    context.apiErrorCode = errorPayload.code;
  }
  if (typeof errorPayload.message === 'string') {
    context.apiErrorMessage = errorPayload.message;
  }

  if (typeof sandboxError.text === 'string' && sandboxError.text.trim()) {
    context.apiResponseBody = truncateForLog(sandboxError.text.trim(), 1000);
  }

  return context;
}

function isSandboxDirectoryAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const sandboxError = error as Error & {
    json?: unknown;
  };

  const errorPayload = asRecord(asRecord(sandboxError.json).error);
  const errorCode = errorPayload.code;
  const errorMessage = errorPayload.message;

  if (
    errorCode === 'file_error' &&
    typeof errorMessage === 'string' &&
    errorMessage.toLowerCase().includes('file exists')
  ) {
    return true;
  }

  return sandboxError.message.toLowerCase().includes('file exists');
}

export interface SessionSandboxRuntime {
  sandboxId: string | null;
  status: SandboxRuntimeState['status'];
  startedAt: string | null;
  lastActiveAt: string | null;
  stoppedAt: string | null;
  timeoutMs: number | null;
  publicPorts: number[];
  lastCommand: string | null;
  lastExitCode: number | null;
  lastError: string | null;
}

function getSandboxPublicPorts(sandbox: Sandbox): number[] {
  return [...new Set(sandbox.routes.map((route) => route.port))].sort(
    (left, right) => left - right,
  );
}

function hasAllConfiguredPublicPorts(ports: number[]): boolean {
  return SANDBOX_PUBLIC_PORTS.every((port) => ports.includes(port));
}

async function ensureWorkspace(sandbox: Sandbox): Promise<void> {
  // sandbox.fs.mkdir (the node:fs/promises-compatible API) supports
  // { recursive: true }, which creates all intermediate directories in
  // one call and is idempotent on existing dirs. This is cleaner than
  // the mkDir API (single-level only) or runCommand('mkdir', ['-p', ...])
  // (depends on cwd resolving correctly, which broke on some sandbox
  // instances whose default cwd pointed at a non-existent home dir).
  const dirs = [
    SANDBOX_WORKSPACE_DIR,
    SANDBOX_DIRS.skills,
    SANDBOX_DIRS.downloads,
    SANDBOX_DIRS.photos,
    SANDBOX_DIRS.videos,
    SANDBOX_DIRS.documents,
    SANDBOX_DIRS.media,
    SANDBOX_DIRS.sessions,
    SANDBOX_DIRS.memory,
    SANDBOX_DIRS.outputs,
    SANDBOX_DIRS.projects,
    SANDBOX_DIRS.bin,
    SANDBOX_DIRS.local,
    SANDBOX_DIRS.localBin,
  ];

  for (const dir of dirs) {
    try {
      await sandbox.fs.mkdir(dir, { recursive: true });
    } catch (error) {
      if (isSandboxDirectoryAlreadyExistsError(error)) {
        continue;
      }
      throw error;
    }
  }
}

async function withSessionSandboxLock<T>(
  sessionId: string,
  action: () => Promise<T>,
): Promise<T> {
  return withKvLock(getSessionSandboxLockKey(sessionId), action, {
    ttlMs: SESSION_SANDBOX_LOCK_TTL_MS,
    acquireTimeoutMs: SESSION_SANDBOX_LOCK_WAIT_MS,
    pollIntervalMs: SESSION_SANDBOX_LOCK_POLL_MS,
  });
}

function getSessionSandboxLockKey(sessionId: string): string {
  return `sandbox:session:${sessionId}`;
}

async function maybeExtendSandboxTimeout(
  sessionId: string,
  sandbox: Sandbox,
): Promise<void> {
  const remainingTimeoutMs = sandbox.timeout;
  if (remainingTimeoutMs >= SANDBOX_TIMEOUT_RENEW_THRESHOLD_MS) {
    return;
  }

  try {
    await sandbox.extendTimeout(SANDBOX_TIMEOUT_RENEW_INCREMENT_MS);
    logger.info('sandbox:extend_timeout', {
      sessionId,
      sandboxId: sandbox.sandboxId,
      remainingTimeoutMs,
      extendByMs: SANDBOX_TIMEOUT_RENEW_INCREMENT_MS,
      timeoutMs: sandbox.timeout,
    });
  } catch (error) {
    logger.warn('sandbox:extend_timeout_failed', {
      sessionId,
      sandboxId: sandbox.sandboxId,
      remainingTimeoutMs,
      extendByMs: SANDBOX_TIMEOUT_RENEW_INCREMENT_MS,
      ...getSandboxErrorLogContext(error),
    });
  }
}

async function createSessionSandbox(sessionId: string): Promise<Sandbox> {
  const requestedPorts = [...SANDBOX_PUBLIC_PORTS];

  logger.info('sandbox:create_start', {
    sessionId,
    timeoutMs: SANDBOX_TIMEOUT_MS,
    runtime: SANDBOX_RUNTIME,
    networkPolicy: SANDBOX_NETWORK_POLICY,
    requestedPorts,
  });

  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.create({
      timeout: SANDBOX_TIMEOUT_MS,
      runtime: SANDBOX_RUNTIME,
      networkPolicy: SANDBOX_NETWORK_POLICY,
      ports: requestedPorts,
    });
  } catch (error) {
    logger.error('sandbox:create_failed', {
      sessionId,
      timeoutMs: SANDBOX_TIMEOUT_MS,
      runtime: SANDBOX_RUNTIME,
      networkPolicy: SANDBOX_NETWORK_POLICY,
      requestedPorts,
      ...getSandboxErrorLogContext(error),
    });
    throw error;
  }

  await ensureWorkspace(sandbox);

  await updateSession(sessionId, {
    sandboxId: sandbox.sandboxId,
  });
  await patchSandboxRuntime(sessionId, {
    status: sandbox.status as SandboxRuntimeState['status'],
    startedAt: nowIso(),
    lastActiveAt: nowIso(),
    stoppedAt: null,
    timeoutMs: sandbox.timeout,
    publicPorts: getSandboxPublicPorts(sandbox),
    lastError: null,
  });

  logger.info('sandbox:create', { sessionId, sandboxId: sandbox.sandboxId });
  return sandbox;
}

async function getOrCreateSessionSandboxInternal(
  sessionId: string,
): Promise<{ sandbox: Sandbox; created: boolean }> {
  const session = await getSession(sessionId);
  if (!session) {
    throw new Error(`Session "${sessionId}" not found.`);
  }

  if (session.sandboxId) {
    try {
      const sandbox = await Sandbox.get({ sandboxId: session.sandboxId });
      if (sandbox.status !== 'running' && sandbox.status !== 'pending') {
        throw new Error(
          `Sandbox is not reusable in status "${sandbox.status}".`,
        );
      }

      const exposedPorts = getSandboxPublicPorts(sandbox);
      if (!hasAllConfiguredPublicPorts(exposedPorts)) {
        throw new Error(
          `Sandbox is missing configured public ports (${SANDBOX_PUBLIC_PORTS.join(', ')}).`,
        );
      }

      await ensureWorkspace(sandbox);
      await patchSandboxRuntime(sessionId, {
        status: sandbox.status as SandboxRuntimeState['status'],
        lastActiveAt: nowIso(),
        timeoutMs: sandbox.timeout,
        publicPorts: exposedPorts,
        lastError: null,
      });
      logger.info('sandbox:reuse', {
        sessionId,
        sandboxId: session.sandboxId,
        publicPorts: exposedPorts,
      });
      return { sandbox, created: false };
    } catch (error) {
      logger.warn('sandbox:get_failed', {
        sessionId,
        sandboxId: session.sandboxId,
        ...getSandboxErrorLogContext(error),
      });
      await updateSession(sessionId, { sandboxId: null });
      await patchSandboxRuntime(sessionId, {
        status: 'missing',
        stoppedAt: nowIso(),
        publicPorts: [],
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    sandbox: await createSessionSandbox(sessionId),
    created: true,
  };
}

export async function getOrCreateSessionSandbox(
  sessionId: string,
): Promise<{ sandbox: Sandbox; created: boolean }> {
  return withSessionSandboxLock(sessionId, () =>
    getOrCreateSessionSandboxInternal(sessionId),
  );
}

export async function withSessionSandbox<T>(
  sessionId: string,
  action: (sandbox: Sandbox, context: { created: boolean }) => Promise<T>,
): Promise<T> {
  return withSessionSandboxLock(sessionId, async () => {
    const { sandbox, created } =
      await getOrCreateSessionSandboxInternal(sessionId);
    await maybeExtendSandboxTimeout(sessionId, sandbox);
    const exposedPorts = getSandboxPublicPorts(sandbox);
    await patchSandboxRuntime(sessionId, {
      status: sandbox.status as SandboxRuntimeState['status'],
      lastActiveAt: nowIso(),
      timeoutMs: sandbox.timeout,
      publicPorts: exposedPorts,
      lastError: null,
    });
    return action(sandbox, { created });
  });
}

export async function stopSessionSandbox(sessionId: string): Promise<void> {
  await withSessionSandboxLock(sessionId, async () => {
    const session = await getSession(sessionId);
    if (!session?.sandboxId) {
      throw new Error('Sandbox is not running.');
    }

    const metadata = getSessionRuntimeMetadata(session.metadata ?? null);
    if (
      metadata.sandbox.status !== 'running' &&
      metadata.sandbox.status !== 'pending'
    ) {
      throw new Error('Sandbox is not running.');
    }

    const sandbox = await Sandbox.get({ sandboxId: session.sandboxId });
    await patchSandboxRuntime(sessionId, {
      status: 'stopping',
    });
    await sandbox.stop({ blocking: true });
    await updateSession(sessionId, { sandboxId: null });
    await patchSandboxRuntime(sessionId, {
      status: 'stopped',
      stoppedAt: nowIso(),
      lastActiveAt: nowIso(),
      publicPorts: [],
    });
  });
}

export async function getSessionSandboxRuntime(
  sessionId: string,
): Promise<SessionSandboxRuntime> {
  const session = await getSession(sessionId);
  if (!session) {
    throw new Error(`Session "${sessionId}" not found.`);
  }

  const metadata = getSessionRuntimeMetadata(session.metadata ?? null);
  return {
    sandboxId: session.sandboxId ?? null,
    status: session.sandboxId ? metadata.sandbox.status : 'idle',
    startedAt: metadata.sandbox.startedAt,
    lastActiveAt: metadata.sandbox.lastActiveAt,
    stoppedAt: metadata.sandbox.stoppedAt,
    timeoutMs: metadata.sandbox.timeoutMs,
    publicPorts: metadata.sandbox.publicPorts,
    lastCommand: metadata.sandbox.lastCommand,
    lastExitCode: metadata.sandbox.lastExitCode,
    lastError: metadata.sandbox.lastError,
  };
}
