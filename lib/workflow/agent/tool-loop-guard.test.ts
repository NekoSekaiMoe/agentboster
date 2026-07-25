import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOOL_LOOP_LIMITS,
  ToolLoopGuard,
  describeLoopTrip,
  inputKeyOf,
} from './tool-loop-guard';

function call(opts: {
  name: string;
  input?: unknown;
  malformed?: boolean;
  error?: boolean;
}) {
  return {
    name: opts.name,
    inputKey: inputKeyOf(opts.input ?? opts.name),
    malformed: opts.malformed ?? false,
    error: opts.error ?? false,
  };
}

function ok(name: string, input: unknown = {}) {
  return call({ name, input, error: false });
}
function fail(name: string, input: unknown = {}) {
  return call({ name, input, error: true });
}
function malformed() {
  return call({ name: '', input: '', malformed: true });
}

describe('ToolLoopGuard', () => {
  it('never trips when tool calls succeed', () => {
    const g = new ToolLoopGuard();
    for (let i = 0; i < 20; i++) {
      g.observe([ok('read', { path: `/f${i}` })]);
    }
    expect(g.tripReason()).toBeNull();
  });

  it('trips on N consecutive all-malformed rounds', () => {
    const g = new ToolLoopGuard();
    // default limit 3; one malformed per round (a round = one observe call).
    // Mirrors aionrs: the malformed tracker only fires when *every* call in
    // a round is malformed, and counts consecutive such rounds.
    g.observe([malformed()]);
    expect(g.tripReason()).toBeNull();
    g.observe([malformed()]);
    expect(g.tripReason()).toBeNull();
    g.observe([malformed()]);
    expect(g.tripReason()).toBe('malformed');
    const snap = g.snapshot();
    expect(snap.malformedCount).toBe(3);
    expect(describeLoopTrip('malformed', snap)).toMatch(/3/);
  });

  it('resets malformed counter when a round has a usable call', () => {
    const g = new ToolLoopGuard();
    g.observe([malformed()]);
    g.observe([malformed()]);
    g.observe([ok('read')]); // resets
    g.observe([malformed()]);
    expect(g.tripReason()).toBeNull();
    expect(g.snapshot().malformedCount).toBe(1);
  });

  it('trips on identical failing fingerprint repeated', () => {
    const g = new ToolLoopGuard();
    const same = fail('write', { path: '/x', content: 'a' });
    g.observe([same]);
    expect(g.snapshot().failureCount).toBe(1);
    g.observe([same]);
    expect(g.snapshot().failureCount).toBe(2);
    g.observe([same]);
    // 3rd observation => count 3 => trips at limit (default 3)
    expect(g.tripReason()).toBe('failure');
  });

  it('does not trip on failures with different inputs (no fingerprint match)', () => {
    const g = new ToolLoopGuard();
    g.observe([fail('write', { path: '/a' })]);
    g.observe([fail('write', { path: '/b' })]);
    g.observe([fail('write', { path: '/c' })]);
    // failure tracker resets each time the fingerprint changes
    expect(g.tripReason()).toBeNull();
    // all_error counter, however, accumulates (each round all-error)
    expect(g.snapshot().allErrorCount).toBe(3);
  });

  it('trips on all-error rounds regardless of fingerprint', () => {
    const g = new ToolLoopGuard({
      ...DEFAULT_TOOL_LOOP_LIMITS,
      // make failure tracker inert so only all_error fires
      maxFailureTurns: 0,
      maxCycleRepetitions: 0,
    });
    g.observe([fail('a')]);
    g.observe([fail('b')]);
    g.observe([fail('c')]);
    expect(g.tripReason()).toBeNull();
    g.observe([fail('d')]);
    g.observe([fail('e')]);
    g.observe([fail('f')]);
    g.observe([fail('g')]);
    g.observe([fail('h')]); // 8th all-error round
    expect(g.tripReason()).toBe('all_error');
  });

  it('resets all_error counter when a round has a success', () => {
    const g = new ToolLoopGuard({
      ...DEFAULT_TOOL_LOOP_LIMITS,
      maxFailureTurns: 0,
      maxCycleRepetitions: 0,
    });
    for (let i = 0; i < 7; i++) g.observe([fail(String(i))]);
    expect(g.tripReason()).toBeNull();
    g.observe([ok('ok')]); // resets all_error
    expect(g.snapshot().allErrorCount).toBe(0);
    g.observe([fail('x')]);
    expect(g.tripReason()).toBeNull();
  });

  it('detects A->B ping-pong cycle (period 2)', () => {
    const g = new ToolLoopGuard({
      ...DEFAULT_TOOL_LOOP_LIMITS,
      // disable other breakers so only cycle fires
      maxFailureTurns: 100,
      maxAllErrorRounds: 100,
    });
    const a = fail('a', { x: 1 });
    const b = fail('b', { x: 2 });
    // Need >= maxCycleRepetitions (default 3) repetitions of a period-2
    // pattern to trip. A B A B A B = pattern (A,B) repeated 3 times.
    g.observe([a]);
    g.observe([b]);
    g.observe([a]);
    g.observe([b]);
    expect(g.tripReason()).toBeNull(); // 2 repetitions < 3
    g.observe([a]);
    g.observe([b]);
    expect(g.tripReason()).toBe('cycle');
    const snap = g.snapshot();
    expect(snap.cycle?.period).toBe(2);
    expect(snap.cycle?.repetitions).toBeGreaterThanOrEqual(3);
  });

  it('does not flag a cycle when failures are aperiodic', () => {
    const g = new ToolLoopGuard({
      ...DEFAULT_TOOL_LOOP_LIMITS,
      maxFailureTurns: 100,
      maxAllErrorRounds: 100,
    });
    g.observe([fail('a', { i: 0 })]);
    g.observe([fail('b', { i: 1 })]);
    g.observe([fail('a', { i: 2 })]);
    g.observe([fail('b', { i: 3 })]);
    // inputs differ each round -> no fingerprint match -> no cycle
    expect(g.tripReason()).toBeNull();
    expect(g.snapshot().cycle).toBeNull();
  });

  it('latches: once tripped, further observations are ignored', () => {
    const g = new ToolLoopGuard();
    // Three consecutive all-malformed rounds to trip the malformed breaker.
    g.observe([malformed()]);
    g.observe([malformed()]);
    g.observe([malformed()]);
    expect(g.tripReason()).toBe('malformed');
    const before = g.snapshot();
    g.observe([ok('fine')]);
    const after = g.snapshot();
    expect(after).toEqual(before);
  });

  it('limit 0 disables that breaker', () => {
    const g = new ToolLoopGuard({
      ...DEFAULT_TOOL_LOOP_LIMITS,
      maxMalformedTurns: 0,
      // disable cycle too so all_error is the only one left that can trip
      maxCycleRepetitions: 0,
      // loosen failure tracker so all_error wins the race
      maxFailureTurns: 100,
    });
    // all-malformed rounds do NOT count as all-error in aionrs semantics
    // (failure_fingerprint is None when no call was executed), so use real
    // failures here to drive the all_error breaker.
    for (let i = 0; i < 8; i++) g.observe([fail(String(i))]);
    expect(g.tripReason()).toBe('all_error');
  });

  it('inputKeyOf is order-independent for objects', () => {
    expect(inputKeyOf({ a: 1, b: 2 })).toBe(inputKeyOf({ b: 2, a: 1 }));
    expect(inputKeyOf({ a: 1, b: 2 })).not.toBe(inputKeyOf({ a: 2, b: 1 }));
    expect(inputKeyOf([1, 2, 3])).toBe(inputKeyOf([1, 2, 3]));
    expect(inputKeyOf(null)).toBe('');
  });

  it('describeLoopTrip produces non-empty messages for every reason', () => {
    for (const reason of [
      'malformed',
      'failure',
      'all_error',
      'cycle',
    ] as const) {
      const msg = describeLoopTrip(reason, {
        malformedCount: 3,
        failureCount: 3,
        allErrorCount: 8,
        cycle: { period: 2, repetitions: 3 },
        tripped: reason,
      });
      expect(msg.length).toBeGreaterThan(0);
    }
  });
});
