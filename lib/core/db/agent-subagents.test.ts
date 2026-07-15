/**
 * Tests for the agent_subagent_batches / agent_subagent_jobs DB layer.
 *
 * Phase C-full of the multi-agent collaboration design. The DB layer
 * moves sub-agent state out of sessions.metadata.workflowSubagents.
 * These tests cover the create/get/update/cancel + legacy-migration
 * paths with an in-memory store (same pattern as agent-handoffs.test.ts).
 *
 * Run via: yarn test lib/core/db/agent-subagents.test.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockBatchRow {
  id: string;
  batchId: string;
  sessionId?: string;
  runId?: string;
  barrierId?: string;
  status: string;
  concurrencyLimit: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  createdAt: Date;
  updatedAt: Date;
}

interface MockJobRow {
  id: string;
  subagentId: string;
  batchStableId: string;
  sessionId?: string;
  agentName: string;
  task: string;
  status: string;
  modelId?: string;
  steps?: number;
  summary?: string;
  error?: string;
  startedAt?: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const hoisted = vi.hoisted(() => {
  const batches = new Map<string, MockBatchRow>();
  const jobs = new Map<string, MockJobRow>();
  let nextId = 1;
  return {
    batches,
    jobs,
    nextId: () => `row_${nextId++}`,
    reset: () => {
      batches.clear();
      jobs.clear();
      nextId = 1;
    },
  };
});

vi.mock('drizzle-orm', () => {
  const eq = (col: string, value: unknown) => (row: Record<string, unknown>) =>
    row[col] === value;
  const and =
    (...preds: Array<(row: Record<string, unknown>) => boolean>) =>
    (row: Record<string, unknown>) =>
      preds.every((p) => p(row));
  const inArray =
    (col: string, values: readonly unknown[]) =>
    (row: Record<string, unknown>) =>
      values.includes(row[col]);
  const asc = () => 'asc';
  return { eq, and, inArray, asc };
});

vi.mock('@/lib/core/db', () => ({
  db: {
    insert: (table: { __type: string }) => ({
      values: (input: Record<string, unknown> | Record<string, unknown>[]) => {
        const records = Array.isArray(input) ? input : [input];
        const stored: Array<Record<string, unknown>> = [];
        for (const r of records) {
          const row: Record<string, unknown> = {
            id: hoisted.nextId(),
            createdAt: new Date(),
            updatedAt: new Date(),
            ...r,
          };
          if (table.__type === 'batches') {
            hoisted.batches.set(
              row.batchId as string,
              row as unknown as MockBatchRow,
            );
          } else {
            hoisted.jobs.set(
              row.subagentId as string,
              row as unknown as MockJobRow,
            );
          }
          stored.push(row);
        }
        // Eagerly store (the real createBatch doesn't always call
        // .returning() on the jobs insert). .returning() / .onConflictDoNothing
        // below are no-ops on top of the already-stored rows.
        return {
          returning: async () => stored,
          onConflictDoNothing: () => ({
            returning: async () => [],
          }),
        };
      },
    }),
    update: (table: { __type: string }) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (pred: (row: Record<string, unknown>) => boolean) => ({
          returning: async () => {
            const store =
              table.__type === 'batches' ? hoisted.batches : hoisted.jobs;
            const out: Array<Record<string, unknown>> = [];
            for (const row of store.values()) {
              if (!pred(row as unknown as Record<string, unknown>)) continue;
              Object.assign(row, patch);
              out.push(row as unknown as Record<string, unknown>);
            }
            return out;
          },
        }),
      }),
    }),
    select: () => ({
      from: (table: { __type: string }) => ({
        where: (pred: (row: Record<string, unknown>) => boolean) => {
          // store is a union of Map<string, MockBatchRow> | Map<string,
          // MockJobRow>. TS can't narrow the iterator type from the
          // union, so cast to a common row type up front.
          const store = (
            table.__type === 'batches' ? hoisted.batches : hoisted.jobs
          ) as Map<string, MockBatchRow | MockJobRow>;
          const rows = Array.from(store.values())
            .filter((r) => pred(r as unknown as Record<string, unknown>))
            .sort((a, b) => a.id.localeCompare(b.id));
          // Return an array-like that the DB layer can either iterate
          // directly OR chain .orderBy() / .limit() onto. We can't
          // attach extra props to a real Array without breaking length
          // (see the phase B handoff tests), so build a plain object
          // with [Symbol.iterator], indexed access, length, and the
          // chainable methods.
          const arrayLike: {
            length: number;
            orderBy: () => typeof arrayLike;
            limit: (n: number) => { length: number };
            [Symbol.iterator](): Iterator<MockBatchRow | MockJobRow>;
            [k: number]: MockBatchRow | MockJobRow;
          } = {
            length: rows.length,
            [Symbol.iterator]() {
              let i = 0;
              return {
                next: () =>
                  i < rows.length
                    ? { value: rows[i++], done: false as const }
                    : { value: undefined, done: true as const },
              };
            },
            orderBy: () => arrayLike,
            limit: (n: number) => {
              const sliced = rows.slice(0, n);
              return {
                length: sliced.length,
                [Symbol.iterator]() {
                  let i = 0;
                  return {
                    next: () =>
                      i < sliced.length
                        ? { value: sliced[i++], done: false as const }
                        : { value: undefined, done: true as const },
                  };
                },
              };
            },
          };
          // Indexed access for callers that do rows[0].
          rows.forEach((r, i) => {
            arrayLike[i] = r;
          });
          return arrayLike;
        },
      }),
    }),
  },
}));

vi.mock('@/lib/core/db/schema', () => ({
  agentSubagentBatches: {
    __type: 'batches',
    id: 'id',
    batchId: 'batchId',
    sessionId: 'sessionId',
    runId: 'runId',
    barrierId: 'barrierId',
    status: 'status',
    concurrencyLimit: 'concurrencyLimit',
    succeeded: 'succeeded',
    failed: 'failed',
    cancelled: 'cancelled',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  agentSubagentJobs: {
    __type: 'jobs',
    id: 'id',
    subagentId: 'subagentId',
    batchStableId: 'batchStableId',
    sessionId: 'sessionId',
    agentName: 'agentName',
    task: 'task',
    status: 'status',
    modelId: 'modelId',
    steps: 'steps',
    summary: 'summary',
    error: 'error',
    startedAt: 'startedAt',
    finishedAt: 'finishedAt',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
}));

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  }),
}));

import {
  createBatch,
  getBatch,
  getBatchWithJobs,
  updateJobStatus,
  cancelBatchJobs,
  recomputeBatchCounters,
  migrateBatchFromLegacyMetadata,
} from './agent-subagents';

describe('agent-subagents DB layer', () => {
  beforeEach(() => {
    hoisted.reset();
  });

  describe('createBatch + getBatch', () => {
    it('creates a batch with queued jobs', async () => {
      const b = await createBatch({
        batchId: 'b1',
        sessionId: 's1',
        concurrencyLimit: 2,
        jobs: [
          { subagentId: 'j1', agentName: 'A', task: 't1' },
          { subagentId: 'j2', agentName: 'B', task: 't2' },
        ],
      });
      expect(b.batchId).toBe('b1');
      expect(b.status).toBe('running');

      const fetched = await getBatch('b1');
      expect(fetched?.batchId).toBe('b1');

      const withJobs = await getBatchWithJobs('b1');
      expect(withJobs?.jobs).toHaveLength(2);
      expect(Array.from(withJobs?.jobs ?? []).map((j) => j.status)).toEqual([
        'queued',
        'queued',
      ]);
    });
  });

  describe('updateJobStatus', () => {
    it('transitions queued → running → completed and bumps counters', async () => {
      await createBatch({
        batchId: 'b1',
        sessionId: 's1',
        concurrencyLimit: 1,
        jobs: [{ subagentId: 'j1', agentName: 'A', task: 't' }],
      });

      await updateJobStatus({ subagentId: 'j1', status: 'running' });
      let b = await getBatch('b1');
      expect(b?.status).toBe('running');
      expect(b?.succeeded).toBe(0);

      await updateJobStatus({
        subagentId: 'j1',
        status: 'completed',
        summary: 'done',
        steps: 3,
      });
      b = await getBatch('b1');
      expect(b?.status).toBe('completed');
      expect(b?.succeeded).toBe(1);
    });

    it('marks batch failed when any job fails', async () => {
      await createBatch({
        batchId: 'b1',
        sessionId: 's1',
        concurrencyLimit: 2,
        jobs: [
          { subagentId: 'j1', agentName: 'A', task: 't' },
          { subagentId: 'j2', agentName: 'B', task: 't' },
        ],
      });

      await updateJobStatus({ subagentId: 'j1', status: 'completed' });
      await updateJobStatus({
        subagentId: 'j2',
        status: 'failed',
        error: 'boom',
      });

      const b = await getBatch('b1');
      expect(b?.status).toBe('failed');
      expect(b?.succeeded).toBe(1);
      expect(b?.failed).toBe(1);
    });

    it('idempotent terminal transition (no double-counting)', async () => {
      await createBatch({
        batchId: 'b1',
        sessionId: 's1',
        concurrencyLimit: 1,
        jobs: [{ subagentId: 'j1', agentName: 'A', task: 't' }],
      });
      await updateJobStatus({ subagentId: 'j1', status: 'completed' });
      // Second terminal update should be a no-op.
      await updateJobStatus({ subagentId: 'j1', status: 'failed' });

      const b = await getBatch('b1');
      expect(b?.succeeded).toBe(1);
      expect(b?.failed).toBe(0);
    });
  });

  describe('cancelBatchJobs', () => {
    it('cancels queued/running jobs and recomputes batch status', async () => {
      await createBatch({
        batchId: 'b1',
        sessionId: 's1',
        concurrencyLimit: 2,
        jobs: [
          { subagentId: 'j1', agentName: 'A', task: 't' },
          { subagentId: 'j2', agentName: 'B', task: 't' },
        ],
      });
      await updateJobStatus({ subagentId: 'j1', status: 'running' });

      const result = await cancelBatchJobs('b1', 'user_aborted');
      expect(result.cancelled).toBe(2);
      expect(result.batch?.status).toBe('cancelled');
      expect(result.batch?.cancelled).toBe(2);
    });
  });

  describe('recomputeBatchCounters (self-heal)', () => {
    it('correctly derives status from jobs after drift', async () => {
      await createBatch({
        batchId: 'b1',
        sessionId: 's1',
        concurrencyLimit: 2,
        jobs: [
          { subagentId: 'j1', agentName: 'A', task: 't' },
          { subagentId: 'j2', agentName: 'B', task: 't' },
        ],
      });
      // Simulate drift: jobs are completed in the DB but batch counters
      // were never bumped (e.g. a crash between updates).
      const j1 = hoisted.jobs.get('j1');
      const j2 = hoisted.jobs.get('j2');
      if (j1 && j2) {
        j1.status = 'completed';
        j2.status = 'completed';
      }
      const b0 = await getBatch('b1');
      expect(b0?.succeeded).toBe(0); // drifted

      const { batch } = await recomputeBatchCounters('b1');
      expect(batch?.succeeded).toBe(2);
      expect(batch?.status).toBe('completed');
    });
  });

  describe('migrateBatchFromLegacyMetadata', () => {
    it('backfills a batch + jobs from the legacy blob', async () => {
      const migrated = await migrateBatchFromLegacyMetadata({
        sessionId: 's1',
        batchId: 'legacy1',
        legacy: {
          batches: {
            legacy1: {
              batchId: 'legacy1',
              status: 'running',
              concurrencyLimit: 2,
              jobs: ['la', 'lb'],
              succeeded: 1,
              failed: 0,
              cancelled: 0,
            },
          },
          jobs: {
            la: {
              subagentId: 'la',
              agentName: 'A',
              task: 'task A',
              status: 'completed',
              summary: 'A done',
              steps: 2,
            },
            lb: {
              subagentId: 'lb',
              agentName: 'B',
              task: 'task B',
              status: 'running',
            },
          },
        },
      });

      expect(migrated).not.toBeNull();
      expect(migrated?.batch.batchId).toBe('legacy1');
      expect(migrated?.batch.concurrencyLimit).toBe(2);
      expect(migrated?.jobs).toHaveLength(2);
      expect(
        Array.from(migrated?.jobs ?? [])
          .map((j) => j.subagentId)
          .sort(),
      ).toEqual(['la', 'lb']);
    });

    it('is idempotent (second call is a no-op read)', async () => {
      const input = {
        sessionId: 's1',
        batchId: 'legacy2',
        legacy: {
          batches: {
            legacy2: {
              batchId: 'legacy2',
              status: 'running',
              concurrencyLimit: 1,
              jobs: ['x'],
              succeeded: 0,
              failed: 0,
              cancelled: 0,
            },
          },
          jobs: {
            x: {
              subagentId: 'x',
              agentName: 'A',
              task: 't',
              status: 'queued',
            },
          },
        },
      };
      await migrateBatchFromLegacyMetadata(input);
      // Second call should hit the early-return (already migrated).
      const before = hoisted.batches.size;
      await migrateBatchFromLegacyMetadata(input);
      expect(hoisted.batches.size).toBe(before);
    });
  });
});
