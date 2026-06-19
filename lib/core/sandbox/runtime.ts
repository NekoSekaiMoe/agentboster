import { getSession, updateSession } from '@/lib/core/db/chat';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('sandbox.runtime');

export const SANDBOX_TIMEOUT_MS = 5 * 60 * 1000;
export const SANDBOX_EXEC_WAIT_TIMEOUT_MS = 30_000;
export const SANDBOX_WORKSPACE_DIR = '/vercel/sandbox/workspace';
export const SANDBOX_MAX_OUTPUT_LENGTH = 30_000;
export const SANDBOX_PUBLIC_PORTS = [3000, 4173, 5173] as const;

// All subdirectories MUST live under SANDBOX_WORKSPACE_DIR. Earlier
// these used a bare "/workspace/..." prefix, but Vercel Sandbox's
// actual working directory is "/vercel/sandbox/workspace" (per
// https://vercel.com/docs/sandbox/system-specifications). mkdir would
// fail with "cannot create directory '/workspace/skills': No such file
// or directory" because /workspace itself didn't exist.
const W = SANDBOX_WORKSPACE_DIR;
export const SANDBOX_DIRS = {
  skills: `${W}/skills`,
  downloads: `${W}/downloads`,
  photos: `${W}/downloads/photos`,
  videos: `${W}/downloads/videos`,
  documents: `${W}/downloads/documents`,
  media: `${W}/media`,
  sessions: `${W}/sessions`,
  memory: `${W}/memory`,
  outputs: `${W}/outputs`,
  projects: `${W}/projects`,
  bin: `${W}/bin`,
  local: `${W}/.local`,
  localBin: `${W}/.local/bin`,
} as const;

export type WorkflowRuntimePhase =
  | 'idle'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'error';

export type SandboxRuntimeStatus =
  | 'idle'
  | 'pending'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'error'
  | 'missing';

export interface WorkflowRuntimeState {
  phase: WorkflowRuntimePhase;
  lastRunId: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  lastError: string | null;
}

export interface SandboxRuntimeState {
  status: SandboxRuntimeStatus;
  startedAt: string | null;
  lastActiveAt: string | null;
  stoppedAt: string | null;
  timeoutMs: number | null;
  publicPorts: number[];
  lastCommand: string | null;
  lastExitCode: number | null;
  lastError: string | null;
}

export interface SessionRuntimeMetadata {
  workflow: WorkflowRuntimeState;
  sandbox: SandboxRuntimeState;
  [key: string]: unknown;
}

const DEFAULT_WORKFLOW_STATE: WorkflowRuntimeState = {
  phase: 'idle',
  lastRunId: null,
  startedAt: null,
  stoppedAt: null,
  lastError: null,
};

const DEFAULT_SANDBOX_STATE: SandboxRuntimeState = {
  status: 'idle',
  startedAt: null,
  lastActiveAt: null,
  stoppedAt: null,
  timeoutMs: null,
  publicPorts: [...SANDBOX_PUBLIC_PORTS],
  lastCommand: null,
  lastExitCode: null,
  lastError: null,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

export function getSessionRuntimeMetadata(
  metadata: unknown,
): SessionRuntimeMetadata {
  const root = asRecord(metadata);
  const workflow = asRecord(root.workflow);
  const sandbox = asRecord(root.sandbox);

  return {
    ...root,
    workflow: {
      ...DEFAULT_WORKFLOW_STATE,
      ...workflow,
    },
    sandbox: {
      ...DEFAULT_SANDBOX_STATE,
      ...sandbox,
    },
  };
}

export async function patchSessionRuntimeMetadata(
  sessionId: string,
  updater: (current: SessionRuntimeMetadata) => SessionRuntimeMetadata,
): Promise<SessionRuntimeMetadata | null> {
  const session = await getSession(sessionId);
  if (!session) {
    logger.warn('patch:session_not_found', { sessionId });
    return null;
  }

  const current = getSessionRuntimeMetadata(session.metadata ?? null);
  const next = updater(current);
  await updateSession(sessionId, { metadata: next });
  return next;
}

export async function patchWorkflowRuntime(
  sessionId: string,
  patch: Partial<WorkflowRuntimeState>,
): Promise<void> {
  await patchSessionRuntimeMetadata(sessionId, (current) => ({
    ...current,
    workflow: {
      ...current.workflow,
      ...patch,
    },
  }));
}

export async function patchSandboxRuntime(
  sessionId: string,
  patch: Partial<SandboxRuntimeState>,
): Promise<void> {
  await patchSessionRuntimeMetadata(sessionId, (current) => ({
    ...current,
    sandbox: {
      ...current.sandbox,
      ...patch,
    },
  }));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function truncateStreamOutput(
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
