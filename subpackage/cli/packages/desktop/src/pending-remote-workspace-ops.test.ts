/**
 * Unit tests for the pending-remote-workspace-op queue merge rules
 * (pending-remote-workspace-ops.ts).
 *
 * The critical scenario: flushPendingRemoteWorkspaceOps snapshots the
 * queue, then awaits per op. If the user renames the same workspace
 * AGAIN mid-flush, recordPendingRemoteWorkspaceOp replaces the queued
 * rename{A} with rename{B}. When the flush later completes rename{A}
 * successfully, the merge must NOT treat the persisted rename{B} as the
 * processed op — dropping it would leave the remote at A with no retry
 * queued, and the next refresh would revert the local title B.
 */

import { describe, expect, it } from 'vitest';

import {
  mergeQueueAfterFlush,
  type PendingRemoteWorkspaceOp,
  pendingRemoteWorkspaceOpsEqual,
  pendingRemoteWorkspaceOpSamePayload,
} from './pending-remote-workspace-ops';

const create = (localId: string): PendingRemoteWorkspaceOp => ({
  kind: 'create',
  localId,
});
const archive = (workspaceId: string): PendingRemoteWorkspaceOp => ({
  kind: 'archive',
  workspaceId,
});
const rename = (
  workspaceId: string,
  title: string,
): PendingRemoteWorkspaceOp => ({ kind: 'rename', workspaceId, title });

describe('pendingRemoteWorkspaceOpsEqual', () => {
  it('matches identity per kind; rename ignores the title payload', () => {
    expect(pendingRemoteWorkspaceOpsEqual(create('a'), create('a'))).toBe(true);
    expect(pendingRemoteWorkspaceOpsEqual(create('a'), create('b'))).toBe(false);
    expect(pendingRemoteWorkspaceOpsEqual(archive('w'), archive('w'))).toBe(true);
    expect(pendingRemoteWorkspaceOpsEqual(rename('w', 'A'), rename('w', 'B'))).toBe(true);
    expect(pendingRemoteWorkspaceOpsEqual(rename('w', 'A'), archive('w'))).toBe(false);
  });
});

describe('pendingRemoteWorkspaceOpSamePayload', () => {
  it('rename requires the same title; other kinds match on identity', () => {
    expect(pendingRemoteWorkspaceOpSamePayload(rename('w', 'A'), rename('w', 'A'))).toBe(true);
    expect(pendingRemoteWorkspaceOpSamePayload(rename('w', 'A'), rename('w', 'B'))).toBe(false);
    expect(pendingRemoteWorkspaceOpSamePayload(archive('w'), archive('w'))).toBe(true);
    expect(pendingRemoteWorkspaceOpSamePayload(create('a'), create('a'))).toBe(true);
  });
});

describe('mergeQueueAfterFlush', () => {
  it('removes a completed op when the persisted copy is unchanged', () => {
    const ops = [rename('w1', 'A')];
    // Persisted queue survived the flush untouched.
    expect(mergeQueueAfterFlush(ops, [], [rename('w1', 'A')])).toEqual([]);
  });

  it('CONCURRENT RENAME: a newer title recorded mid-flush survives the completed op', () => {
    // Flush snapshotted rename{w1,A} and completed it; meanwhile the user
    // renamed w1 to B, replacing the persisted entry.
    const ops = [rename('w1', 'A')];
    const persisted = [rename('w1', 'B')];
    expect(mergeQueueAfterFlush(ops, [], persisted)).toEqual([rename('w1', 'B')]);
  });

  it('keeps a transiently failed op exactly once (no duplicate retry)', () => {
    const op = rename('w1', 'A');
    // Failed (network) → in `remaining`; persisted copy unchanged.
    expect(mergeQueueAfterFlush([op], [op], [rename('w1', 'A')])).toEqual([
      rename('w1', 'A'),
    ]);
  });

  it('a newer persisted payload supersedes a stale retry for the same identity', () => {
    // Flush failed rename{w1,A} (network), but the user already re-recorded
    // rename{w1,B} — the stale A retry must be dropped, B wins.
    const op = rename('w1', 'A');
    expect(mergeQueueAfterFlush([op], [op], [rename('w1', 'B')])).toEqual([
      rename('w1', 'B'),
    ]);
  });

  it('ops of other identities recorded mid-flush survive untouched', () => {
    const ops = [archive('w1')];
    const persisted = [archive('w1'), create('local-9'), rename('w2', 'T')];
    expect(mergeQueueAfterFlush(ops, [], persisted)).toEqual([
      create('local-9'),
      rename('w2', 'T'),
    ]);
  });

  it('a definitively rejected op is dropped like a completed one', () => {
    // Rejected ops are neither retried nor kept — same handling as success.
    const ops = [archive('w1'), rename('w2', 'A')];
    expect(
      mergeQueueAfterFlush(ops, [], [archive('w1'), rename('w2', 'A')]),
    ).toEqual([]);
  });

  it('mixed pass: completed create removed, failed archive retried, new rename kept', () => {
    const createOp = create('local-1');
    const archiveOp = archive('w1');
    const ops = [createOp, archiveOp];
    const persisted = [create('local-1'), archive('w1'), rename('w2', 'T')];
    expect(mergeQueueAfterFlush(ops, [archiveOp], persisted)).toEqual([
      archive('w1'),
      rename('w2', 'T'),
    ]);
  });
});
