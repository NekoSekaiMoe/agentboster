import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMocks, startMock, getRunMock } = vi.hoisted(() => ({
  dbMocks: {
    getSessionHeartbeat: vi.fn(),
    claimHeartbeatWorkflowRunId: vi.fn(),
    recordHeartbeatResult: vi.fn(),
    claimDueHeartbeat: vi.fn(),
    disableSessionHeartbeat: vi.fn(),
  },
  startMock: vi.fn(),
  getRunMock: vi.fn(),
}));

vi.mock('workflow/api', () => ({
  start: startMock,
  getRun: getRunMock,
}));

vi.mock('@/lib/workflow/scheduled/heartbeat', () => ({
  sessionHeartbeatWorkflow: vi.fn(),
}));

vi.mock('@/lib/core/db/heartbeat', () => ({
  ...dbMocks,
  MAX_HEARTBEAT_FAILURES: 3,
}));

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { ensureHeartbeatWorkflow } from './heartbeat-dispatch';

function liveRun(runId: string) {
  return { runId, cancel: vi.fn(), status: Promise.resolve('running') };
}

describe('ensureHeartbeatWorkflow exactly-one-run coordination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reuses a still-live run instead of stacking a second loop', async () => {
    dbMocks.getSessionHeartbeat.mockResolvedValue({
      heartbeatWorkflowRunId: 'run-live',
    });
    getRunMock.mockReturnValue({
      status: Promise.resolve('running'),
    });

    await expect(ensureHeartbeatWorkflow('sess-1')).resolves.toBe('run-live');
    expect(startMock).not.toHaveBeenCalled();
    expect(dbMocks.claimHeartbeatWorkflowRunId).not.toHaveBeenCalled();
  });

  it('reuses a pending run as well', async () => {
    dbMocks.getSessionHeartbeat.mockResolvedValue({
      heartbeatWorkflowRunId: 'run-pending',
    });
    getRunMock.mockReturnValue({
      status: Promise.resolve('pending'),
    });

    await expect(ensureHeartbeatWorkflow('sess-1')).resolves.toBe(
      'run-pending',
    );
    expect(startMock).not.toHaveBeenCalled();
  });

  it('replaces a terminal run and claims the slot with the old id as expected', async () => {
    dbMocks.getSessionHeartbeat.mockResolvedValue({
      heartbeatWorkflowRunId: 'run-dead',
    });
    getRunMock.mockReturnValue({
      status: Promise.resolve('completed'),
    });
    startMock.mockResolvedValue(liveRun('run-new'));
    dbMocks.claimHeartbeatWorkflowRunId.mockResolvedValue('run-new');

    await expect(ensureHeartbeatWorkflow('sess-1')).resolves.toBe('run-new');
    expect(dbMocks.claimHeartbeatWorkflowRunId).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      expectedRunId: 'run-dead',
      newRunId: 'run-new',
    });
  });

  it('starts a fresh run when no run id is recorded', async () => {
    dbMocks.getSessionHeartbeat.mockResolvedValue(null);
    startMock.mockResolvedValue(liveRun('run-fresh'));
    dbMocks.claimHeartbeatWorkflowRunId.mockResolvedValue('run-fresh');

    await expect(ensureHeartbeatWorkflow('sess-1')).resolves.toBe('run-fresh');
    expect(dbMocks.claimHeartbeatWorkflowRunId).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      expectedRunId: null,
      newRunId: 'run-fresh',
    });
  });

  it('cancels its own run when a concurrent ensure wins the race', async () => {
    dbMocks.getSessionHeartbeat.mockResolvedValue(null);
    const cancelled = liveRun('run-loser');
    startMock.mockResolvedValue(cancelled);
    // CAS matched 0 rows — someone else already parked their run id.
    dbMocks.claimHeartbeatWorkflowRunId.mockResolvedValue(null);

    await expect(ensureHeartbeatWorkflow('sess-1')).resolves.toBeNull();
    expect(cancelled.cancel).toHaveBeenCalledTimes(1);
  });

  it('falls back to starting when the recorded run id is unknown (evicted)', async () => {
    dbMocks.getSessionHeartbeat.mockResolvedValue({
      heartbeatWorkflowRunId: 'run-evicted',
    });
    getRunMock.mockImplementation(() => {
      throw new Error('WorkflowRunNotFoundError');
    });
    startMock.mockResolvedValue(liveRun('run-replacement'));
    dbMocks.claimHeartbeatWorkflowRunId.mockResolvedValue('run-replacement');

    await expect(ensureHeartbeatWorkflow('sess-1')).resolves.toBe(
      'run-replacement',
    );
    expect(dbMocks.claimHeartbeatWorkflowRunId).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      expectedRunId: 'run-evicted',
      newRunId: 'run-replacement',
    });
  });

  it('returns null (best-effort) when starting throws', async () => {
    dbMocks.getSessionHeartbeat.mockResolvedValue(null);
    startMock.mockRejectedValue(new Error('queue unavailable'));

    await expect(ensureHeartbeatWorkflow('sess-1')).resolves.toBeNull();
  });
});
