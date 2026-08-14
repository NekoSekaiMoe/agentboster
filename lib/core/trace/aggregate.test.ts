import { describe, expect, it } from 'vitest';

import {
  buildTraceDetail,
  buildTraceSummary,
  type TraceModelRow,
  type TraceReviewRow,
  type TraceToolRow,
} from './aggregate';

const traceId = 'run-trace-1';

function modelRow(
  id: string,
  stepNumber: number,
  startedAt: string,
  completedAt: string,
  finishReason: string,
  totalTokens: number,
): TraceModelRow {
  return {
    id,
    traceId,
    sessionId: '00000000-0000-0000-0000-000000000001',
    sessionTitle: 'Trace test session',
    userId: 'user-1',
    role: 'assistant',
    stepNumber,
    createdAt: startedAt,
    payload: {
      text: `step ${stepNumber}`,
      finishReason,
      usage: { totalTokens },
      metadata: {
        runId: traceId,
        traceCompletedAt: completedAt,
        traceDurationMs:
          new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      },
    },
  };
}

function toolRow(overrides: Partial<TraceToolRow> = {}): TraceToolRow {
  return {
    id: 'tool-1',
    traceId,
    sessionId: '00000000-0000-0000-0000-000000000001',
    sessionTitle: 'Trace test session',
    userId: 'user-1',
    agentId: 'main',
    toolName: 'sandbox.exec',
    action: 'execute',
    target: 'yarn test',
    arguments: { command: 'yarn test' },
    result: null,
    outputText: null,
    success: false,
    error: 'command failed',
    durationMs: 500,
    startedAt: '2026-08-14T00:00:00.500Z',
    completedAt: '2026-08-14T00:00:01.000Z',
    ...overrides,
  };
}

function reviewRow(overrides: Partial<TraceReviewRow> = {}): TraceReviewRow {
  return {
    id: 'review-1',
    traceId,
    taskId: '00000000-0000-0000-0000-000000000002',
    sessionId: '00000000-0000-0000-0000-000000000001',
    sessionTitle: 'Trace test session',
    userId: 'user-1',
    agentId: 'main',
    level: 'L0',
    decision: 'allowed',
    score: 0,
    command: 'yarn test',
    reason: 'no rule matched',
    createdAt: '2026-08-14T00:00:00.250Z',
    ...overrides,
  };
}

describe('trace aggregation', () => {
  it('merges model, review, and tool records into one ordered timeline', () => {
    const detail = buildTraceDetail({
      traceId,
      models: [
        modelRow(
          'model-1',
          0,
          '2026-08-14T00:00:00.000Z',
          '2026-08-14T00:00:00.200Z',
          'tool-calls',
          30,
        ),
        modelRow(
          'model-2',
          1,
          '2026-08-14T00:00:01.100Z',
          '2026-08-14T00:00:02.000Z',
          'stop',
          20,
        ),
      ],
      tools: [toolRow()],
      reviews: [reviewRow()],
      hint: {
        lastRunId: traceId,
        phase: 'completed',
        stoppedAt: '2026-08-14T00:00:02.100Z',
      },
    });

    expect(detail.events.map((event) => event.kind)).toEqual([
      'model',
      'review',
      'tool',
      'model',
    ]);
    expect(detail.summary).toMatchObject({
      traceId,
      status: 'completed',
      modelStepCount: 2,
      toolCount: 1,
      reviewCount: 1,
      failureCount: 1,
      totalTokens: 50,
      lastError: 'command failed',
    });
    expect(detail.summary.durationMs).toBe(2100);
  });

  it('keeps a currently active run open even when its latest event completed', () => {
    const summary = buildTraceSummary({
      traceId,
      models: [
        modelRow(
          'model-running',
          0,
          '2026-08-14T00:00:00.000Z',
          '2026-08-14T00:00:00.200Z',
          'tool-calls',
          10,
        ),
      ],
      tools: [toolRow({ success: true, error: null })],
      hint: { currentRunId: traceId, phase: 'running' },
    });

    expect(summary.status).toBe('running');
    expect(summary.completedAt).toBeNull();
    expect(summary.durationMs).toBeGreaterThan(0);
  });

  it.each([
    {
      label: 'a successful tool event',
      rows: { tools: [toolRow({ success: true, error: null })] },
      expected: 'completed',
    },
    {
      label: 'a failed tool event',
      rows: { tools: [toolRow()] },
      expected: 'failed',
    },
    {
      label: 'an allowed review event',
      rows: { reviews: [reviewRow()] },
      expected: 'completed',
    },
    {
      label: 'a blocked review event',
      rows: { reviews: [reviewRow({ decision: 'blocked' })] },
      expected: 'failed',
    },
    {
      label: 'only a pending review event',
      rows: { reviews: [reviewRow({ decision: 'pending_l2' })] },
      expected: 'unknown',
    },
  ])(
    'derives $expected from $label without model events',
    ({ rows, expected }) => {
      expect(buildTraceSummary({ traceId, ...rows }).status).toBe(expected);
    },
  );

  it('keeps an explicit status hint ahead of fallback event outcomes', () => {
    const summary = buildTraceSummary({
      traceId,
      tools: [toolRow()],
      hint: { currentRunId: traceId, phase: 'running' },
    });

    expect(summary.status).toBe('running');
  });

  it('does not let a completed tool hide a model without a terminal status', () => {
    const summary = buildTraceSummary({
      traceId,
      models: [
        modelRow(
          'model-running-without-hint',
          0,
          '2026-08-14T00:00:00.000Z',
          '2026-08-14T00:00:00.200Z',
          '',
          10,
        ),
      ],
      tools: [toolRow({ success: true, error: null })],
    });

    expect(summary.status).toBe('unknown');
  });
});
