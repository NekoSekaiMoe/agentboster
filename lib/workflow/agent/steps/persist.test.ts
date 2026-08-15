import { beforeEach, describe, expect, it, vi } from 'vitest';

// finalizeRunStep touches several DB write layers (sessions, runtime
// patches, messages, trace runs). For this regression test we only care
// about the durationMs derivation handed to finalizeTraceRun, so all
// side-effectful layers are mocked.

const {
  getSession,
  updateSession,
  patchWorkflowRuntime,
  saveMessages,
  writeSystemEvent,
  writeStepEvent,
  ensureTraceRun,
  finalizeTraceRun,
  ingestTraceSpan,
  getCanonicalTraceRun,
} = vi.hoisted(() => ({
  getSession: vi.fn(),
  updateSession: vi.fn().mockResolvedValue(undefined),
  patchWorkflowRuntime: vi.fn().mockResolvedValue(undefined),
  saveMessages: vi.fn().mockResolvedValue(undefined),
  writeSystemEvent: vi.fn().mockResolvedValue(undefined),
  writeStepEvent: vi.fn().mockResolvedValue(undefined),
  ensureTraceRun: vi.fn().mockResolvedValue(null),
  finalizeTraceRun: vi.fn().mockResolvedValue(null),
  ingestTraceSpan: vi.fn().mockResolvedValue(null),
  getCanonicalTraceRun: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/core/db/chat', () => ({
  getSession,
  updateSession,
  saveMessages,
  upsertPersistedMessage: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/core/trace/dal', () => ({
  ensureTraceRun,
  finalizeTraceRun,
  getCanonicalTraceRun,
  ingestTraceSpan,
}));
vi.mock('@/lib/core/sandbox/runtime', () => ({
  nowIso: () => '2026-08-14T00:00:00.000Z',
  patchWorkflowRuntime,
}));
vi.mock('@/lib/memory', () => ({
  getCurrentSessionSummary: vi.fn().mockResolvedValue(null),
  writeSummaryFromCompaction: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock('workflow', () => ({
  getWorkflowMetadata: () => ({}),
}));
vi.mock('../sender/bot-steps', () => ({
  sendSourceReplyStep: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../sender/writers', () => ({
  writeStepEvent,
  writeSystemEvent,
  writeTokenUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./compress', () => ({
  generateCompressedContext: vi.fn(),
}));

import { finalizeRunStep } from './persist';

const sessionId = '00000000-0000-0000-0000-000000000001';

/** Session created long before either run — the stale fallback that must
 * NOT leak into run durations anymore. */
const staleSessionCreatedAt = '2026-08-01T00:00:00.000Z';

function mockSession(activeRunId: string | null) {
  getSession.mockResolvedValue({
    id: sessionId,
    workflowRunId: activeRunId,
    status: 'running',
    createdAt: staleSessionCreatedAt,
    metadata: {},
  });
}

describe('finalizeRunStep duration derivation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives each run duration from that run own startedAt, not session.createdAt', async () => {
    const run1StartedAt = new Date('2026-08-14T10:00:00.000Z');
    const run2StartedAt = new Date('2026-08-14T11:00:00.000Z');

    // --- First run of the session. ---
    mockSession('run-1');
    getCanonicalTraceRun.mockResolvedValue({ startedAt: run1StartedAt });
    const finalized1 = new Date('2026-08-14T10:00:30.000Z');
    vi.setSystemTime(finalized1);
    try {
      await finalizeRunStep({ sessionId, runId: 'run-1', status: 'completed' });
    } finally {
      vi.useRealTimers();
    }

    expect(finalizeTraceRun).toHaveBeenCalledTimes(1);
    expect(finalizeTraceRun).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'run-1',
        durationMs: 30_000,
      }),
    );

    // --- Second run of the same session, 1h later, runs 5s. ---
    mockSession('run-2');
    getCanonicalTraceRun.mockResolvedValue({ startedAt: run2StartedAt });
    const finalized2 = new Date('2026-08-14T11:00:05.000Z');
    vi.setSystemTime(finalized2);
    try {
      await finalizeRunStep({ sessionId, runId: 'run-2', status: 'completed' });
    } finally {
      vi.useRealTimers();
    }

    expect(finalizeTraceRun).toHaveBeenCalledTimes(2);
    expect(finalizeTraceRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        traceId: 'run-2',
        // 5 seconds — NOT ~13h, which is what the old session.createdAt
        // fallback produced for the second run of a session.
        durationMs: 5_000,
      }),
    );
  });

  it('falls back to null when the canonical run or its startedAt is missing', async () => {
    mockSession('run-3');
    getCanonicalTraceRun.mockResolvedValue(null);
    await finalizeRunStep({ sessionId, runId: 'run-3', status: 'completed' });
    expect(finalizeTraceRun).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 'run-3', durationMs: null }),
    );

    finalizeTraceRun.mockClear();
    getCanonicalTraceRun.mockResolvedValue({ startedAt: null });
    await finalizeRunStep({ sessionId, runId: 'run-3', status: 'completed' });
    expect(finalizeTraceRun).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 'run-3', durationMs: null }),
    );
  });

  it('prefers an explicit finite durationMs over any derivation', async () => {
    mockSession('run-4');
    getCanonicalTraceRun.mockResolvedValue({
      startedAt: new Date('2026-08-14T10:00:00.000Z'),
    });
    await finalizeRunStep({
      sessionId,
      runId: 'run-4',
      status: 'completed',
      durationMs: 1234.9,
    });
    expect(finalizeTraceRun).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 'run-4', durationMs: 1234 }),
    );
  });
});
