/**
 * Tests for the L2 decision queue.
 *
 * P3.2: the queue's concurrency/promotion logic is intricate and was
 * previously untested. These tests exercise the in-memory state
 * machine; the DB layer is mocked by stubbing the dynamic import.
 *
 * Run via: yarn test lib/security/l2-decision-queue.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DecisionQueue,
  DecisionStatus,
  DecisionType,
  type Decision,
} from './l2-decision-queue';

// Stub the DB layer so the queue runs without a real Postgres connection.
// The dynamic import in rehydrateFromDb() resolves to this mock.
vi.mock('@/lib/core/db/l2-decisions', () => ({
  createDecision: vi.fn(async () => ({})),
  resolveDecision: vi.fn(async () => ({})),
  markExpired: vi.fn(async () => ({})),
  expireStaleDecisions: vi.fn(async () => []),
  loadActiveDecisions: vi.fn(async () => []),
  countByStatus: vi.fn(async () => 0),
}));
vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  }),
}));

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    decisionId: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: DecisionType.L2_AUTH,
    taskId: 'task-1',
    sessionId: 'sess-1',
    status: DecisionStatus.PENDING,
    createdAt: new Date(),
    timeoutAt: new Date(Date.now() + 5 * 60 * 1000),
    ...overrides,
  };
}

describe('DecisionQueue', () => {
  let queue: DecisionQueue;

  beforeEach(() => {
    queue = new DecisionQueue();
  });

  afterEach(() => {
    queue.stop();
  });

  describe('enqueue + listPending', () => {
    it('adds a decision to the pending list', async () => {
      const d = makeDecision();
      await queue.enqueue(d);
      const pending = queue.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].decisionId).toBe(d.decisionId);
    });

    it('immediately promotes the first decision for a task to "sent"', async () => {
      const d = makeDecision();
      const promoted = await queue.enqueue(d);
      expect(promoted).toBe(true);
      const sent = queue.getSent();
      expect(sent).toHaveLength(1);
    });

    it('serializes decisions from different tasks', async () => {
      const d1 = makeDecision({ taskId: 'task-a' });
      const d2 = makeDecision({ taskId: 'task-b' });
      await queue.enqueue(d1);
      const promoted2 = await queue.enqueue(d2);
      // task-b can't preempt task-a (different task, task-a has a sent slot)
      expect(promoted2).toBe(false);
      const sent = queue.getSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].taskId).toBe('task-a');
    });

    it('allows up to MAX_CONCURRENT_PER_TASK same-task decisions concurrently', async () => {
      const d1 = makeDecision({ taskId: 'task-x' });
      const d2 = makeDecision({ taskId: 'task-x' });
      const d3 = makeDecision({ taskId: 'task-x' });
      const d4 = makeDecision({ taskId: 'task-x' });
      await queue.enqueue(d1);
      await queue.enqueue(d2);
      await queue.enqueue(d3);
      const promoted4 = await queue.enqueue(d4);
      // First 3 promoted; 4th exceeds cap and stays pending.
      expect(promoted4).toBe(false);
      expect(queue.getSent()).toHaveLength(3);
    });
  });

  describe('resolve + deny', () => {
    it('marks a resolved decision terminal and frees the slot', async () => {
      const d = makeDecision({ taskId: 'task-y' });
      await queue.enqueue(d);
      await queue.resolve(d.decisionId, 'pass:once', 'user-1');

      const after = queue.get(d.decisionId);
      expect(after?.status).toBe(DecisionStatus.RESOLVED);
      expect(after?.resolvedBy).toBe('user-1');
      expect(after?.action).toBe('pass:once');

      // Resolved decisions fall out of listPending.
      expect(queue.listPending()).toHaveLength(0);
    });

    it('marks a denied decision terminal with action=deny', async () => {
      const d = makeDecision();
      await queue.enqueue(d);
      await queue.deny(d.decisionId, 'user-2');
      const after = queue.get(d.decisionId);
      expect(after?.status).toBe(DecisionStatus.DENIED);
      expect(after?.action).toBe('deny');
    });

    it('resolving one decision promotes the next pending from same task', async () => {
      // Enqueue 4 same-task decisions; 3 sent + 1 pending.
      const ids = ['d1', 'd2', 'd3', 'd4'];
      for (const id of ids) {
        await queue.enqueue(makeDecision({ decisionId: id, taskId: 'task-z' }));
      }
      expect(queue.getSent()).toHaveLength(3);
      expect(queue.listPending()).toHaveLength(4); // listPending = pending + sent

      // Resolve one → the 4th should be promoted.
      await queue.resolve('d1', 'pass', 'u');
      const sentIds = queue
        .getSent()
        .map((d) => d.decisionId)
        .sort();
      expect(sentIds).toEqual(['d2', 'd3', 'd4']);
    });
  });

  describe('expire', () => {
    it('marks a decision expired', async () => {
      const d = makeDecision();
      await queue.enqueue(d);
      await queue.expire(d.decisionId);
      const after = queue.get(d.decisionId);
      expect(after?.status).toBe(DecisionStatus.EXPIRED);
      expect(after?.action).toBe('timeout');
    });
  });

  describe('get', () => {
    it('returns null for an unknown id', () => {
      expect(queue.get('nope')).toBeNull();
    });

    it('returns a defensive copy so callers cannot mutate the queue', async () => {
      const d = makeDecision({ decisionId: 'peek' });
      await queue.enqueue(d);
      const view1 = queue.get('peek');
      const view2 = queue.get('peek');
      expect(view1).not.toBe(view2); // different object references
      expect(view1?.decisionId).toBe('peek');
    });
  });
});
