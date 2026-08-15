import { describe, expect, it } from 'vitest';

import {
  buildTraceDetail,
  buildTraceEvents,
  buildTraceSummary,
  type TraceEvent,
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

  it('orders a mixed timeline of canonical (sequence) and legacy rows by time first', () => {
    // Canonical records carry sequence; legacy model/tool/review rows do not.
    const canonicalEvent = (n: number, startedAt: string): TraceEvent => ({
      id: `canonical-${n}`,
      traceId,
      kind: 'tool',
      status: 'completed',
      title: `canonical ${n}`,
      subtitle: null,
      step: null,
      startedAt,
      completedAt: startedAt,
      durationMs: 0,
      details: {},
      sequence: n,
    });

    const events = buildTraceEvents({
      traceId,
      // Legacy rows: no sequence anywhere.
      models: [
        modelRow(
          'model-legacy',
          0,
          '2026-08-14T00:00:00.300Z',
          '2026-08-14T00:00:00.400Z',
          'stop',
          10,
        ),
      ],
      tools: [toolRow()],
      reviews: [reviewRow()],
      // Canonical events interleaved in time with the legacy rows.
      events: [
        canonicalEvent(1, '2026-08-14T00:00:00.100Z'),
        canonicalEvent(2, '2026-08-14T00:00:00.350Z'),
        canonicalEvent(3, '2026-08-14T00:00:00.800Z'),
      ],
    });

    // Deterministic, time-ascending order regardless of sequence presence:
    // review (00:00.250 legacy), canonical-1 (00:00.100), model-legacy
    // (00:00.300), canonical-2 (00:00.350), tool-1 (00:00.500 legacy),
    // canonical-3 (00:00.800).
    expect(events.map((event) => event.id)).toEqual([
      'canonical-1',
      'review:review-1',
      `model:${traceId}:0:model-legacy`,
      'canonical-2',
      'tool:tool-1',
      'canonical-3',
    ]);
  });

  it('refines same-timestamp canonical records by sequence', () => {
    const canonicalEvent = (n: number): TraceEvent => ({
      id: `canonical-${n}`,
      traceId,
      kind: 'tool',
      status: 'completed',
      title: `canonical ${n}`,
      subtitle: null,
      step: null,
      startedAt: '2026-08-14T00:00:00.000Z',
      completedAt: '2026-08-14T00:00:00.000Z',
      durationMs: 0,
      details: {},
      sequence: n,
    });

    const events = buildTraceEvents({
      traceId,
      events: [canonicalEvent(3), canonicalEvent(1), canonicalEvent(2)],
    });

    expect(events.map((event) => event.id)).toEqual([
      'canonical-1',
      'canonical-2',
      'canonical-3',
    ]);
  });

  it('keeps the comparator transitive for the A/B/C counterexample', () => {
    // A: canonical, sequence=1, latest startedAt.
    // B: legacy, no sequence, middle startedAt.
    // C: canonical, sequence=2, earliest startedAt.
    // Old hybrid comparator: C < B (time), B < A (time), but A < C (sequence)
    // — non-transitive. New global order must be purely time-driven here.
    const event = (
      id: string,
      startedAt: string,
      sequence?: number,
    ): TraceEvent => ({
      id,
      traceId,
      kind: 'tool',
      status: 'completed',
      title: id,
      subtitle: null,
      step: null,
      startedAt,
      completedAt: startedAt,
      durationMs: 0,
      details: {},
      sequence,
    });
    const a = event('a', '2026-08-14T00:00:00.900Z', 1);
    const b = event('b', '2026-08-14T00:00:00.500Z');
    const c = event('c', '2026-08-14T00:00:00.100Z', 2);

    const events = buildTraceEvents({ traceId, events: [a, b, c] });
    expect(events.map((event) => event.id)).toEqual(['c', 'b', 'a']);
    const sortedIds = (input: TraceEvent[]) =>
      buildTraceEvents({ traceId, events: input }).map((event) => event.id);

    // Transitivity invariant over every permutation: the sorted result must
    // be identical no matter the input order, and the pairwise comparator
    // (a pure function of its two arguments) must agree with the global
    // order c < b < a in every permutation.
    const comparator = (l: TraceEvent, r: TraceEvent) =>
      (buildTraceEvents({ traceId, events: [l, r] }).at(0)?.id ?? '') === l.id
        ? -1
        : 1;
    for (const [x, y, z] of [
      [a, b, c] as const,
      [a, c, b] as const,
      [b, a, c] as const,
      [b, c, a] as const,
      [c, a, b] as const,
      [c, b, a] as const,
    ]) {
      expect(sortedIds([x, y, z])).toEqual(['c', 'b', 'a']);
      // Global order: c < b < a regardless of input permutation.
      expect(comparator(c, b)).toBeLessThanOrEqual(0);
      expect(comparator(b, a)).toBeLessThanOrEqual(0);
      expect(comparator(c, a)).toBeLessThanOrEqual(0);
    }
  });
});
