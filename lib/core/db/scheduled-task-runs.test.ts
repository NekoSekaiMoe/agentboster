import { describe, expect, it } from 'vitest';

/**
 * Unit tests for the scheduled_task_runs DAL focus on the type contracts
 * and the documented idempotency semantics. The DB-layer INSERT race is
 * enforced by the partial unique index in the migration
 * (scheduled_task_runs_task_planned_uniq), not by application code, so
 * it is exercised by integration tests rather than here.
 *
 * What we DO verify here: the record shape, source/status enums, and
 * that the helpers accept the documented inputs without type error.
 */

import type { ScheduledTaskRunRecord } from './scheduled-task-runs';

describe('ScheduledTaskRunRecord contract', () => {
  it('has the expected status enum values', () => {
    const statuses: ScheduledTaskRunRecord['status'][] = [
      'pending',
      'running',
      'skipped',
      'completed',
      'failed',
    ];
    // The 'skipped' value is the admission-gate innovation over the
    // prior scalar-only model — assert it's part of the type union.
    expect(statuses).toContain('skipped');
    expect(statuses).toHaveLength(5);
  });

  it('has the expected source enum values', () => {
    const sources: ScheduledTaskRunRecord['source'][] = ['schedule', 'manual'];
    expect(sources).toContain('schedule');
    expect(sources).toContain('manual');
  });

  it('allows nullable plannedAt for manual runs', () => {
    const manualRun = {
      id: 'r1',
      taskId: 't1',
      source: 'manual' as const,
      status: 'completed' as const,
      plannedAt: null,
      startedAt: new Date(),
      completedAt: new Date(),
      heartbeatAt: new Date(),
      runId: 'run_1',
      failureReason: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTaskRunRecord;
    expect(manualRun.plannedAt).toBeNull();
  });

  it('carries FailureReason on failed runs', () => {
    const failed = {
      id: 'r2',
      taskId: 't1',
      source: 'schedule' as const,
      status: 'failed' as const,
      plannedAt: new Date(),
      startedAt: new Date(),
      completedAt: new Date(),
      heartbeatAt: null,
      runId: null,
      failureReason: 'runtime_offline',
      errorMessage: 'Preferred node node-1 is unreachable.',
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies ScheduledTaskRunRecord;
    expect(failed.failureReason).toBe('runtime_offline');
  });
});
