import { describe, expect, it } from 'vitest';

import { sanitizeOperations } from './phase3-sanitize';
import type { DreamOperation } from './types';

describe('sanitizeOperations', () => {
  it('passes through unrelated operations untouched', () => {
    const ops: DreamOperation[] = [
      {
        type: 'CONSOLIDATE',
        sourceMemoryIds: ['a', 'b'],
        mergedKey: 'user.lang',
        mergedContent: 'the user writes TypeScript',
        mergedType: 'fact',
        mergedImportance: 7,
        confidence: 0.9,
      },
      {
        type: 'DELETE',
        memoryIds: ['c'],
      },
    ];
    const { accepted, rejectedDuplicates } = sanitizeOperations(ops);
    expect(accepted).toHaveLength(2);
    expect(rejectedDuplicates).toBe(0);
  });

  it('collapses near-duplicate CONSOLIDATE outputs (same word order, one swap)', () => {
    const ops: DreamOperation[] = [
      {
        type: 'CONSOLIDATE',
        sourceMemoryIds: ['a', 'b'],
        mergedKey: 'user.lang',
        mergedContent: 'the user prefers typescript over javascript',
        mergedType: 'fact',
        mergedImportance: 7,
        confidence: 0.9,
      },
      {
        type: 'CONSOLIDATE',
        sourceMemoryIds: ['x', 'y'],
        mergedKey: 'user.lang2',
        // near-duplicate of the first (same order, one word swap) — rejected
        mergedContent: 'the user prefers typescript over python',
        mergedType: 'fact',
        mergedImportance: 7,
        confidence: 0.8,
      },
    ];
    const { accepted, rejectedDuplicates } = sanitizeOperations(ops);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].type).toBe('CONSOLIDATE');
    expect(rejectedDuplicates).toBe(1);
  });

  it('skips SUPERSEDE whose source was already superseded in the same batch', () => {
    const ops: DreamOperation[] = [
      {
        type: 'SUPERSEDE',
        oldMemoryId: 'dup1',
        newMemoryId: 'survivor',
      },
      {
        type: 'SUPERSEDE',
        oldMemoryId: 'dup1', // already consumed above — must be dropped
        newMemoryId: 'other',
      },
    ];
    const { accepted, rejectedDuplicates } = sanitizeOperations(ops);
    expect(accepted).toHaveLength(1);
    expect(rejectedDuplicates).toBe(1);
  });

  it('filters DELETE ids that were already superseded', () => {
    const ops: DreamOperation[] = [
      {
        type: 'SUPERSEDE',
        oldMemoryId: 'mem1',
        newMemoryId: 'mem2',
      },
      {
        type: 'DELETE',
        memoryIds: ['mem1', 'mem3'], // mem1 already consumed
      },
    ];
    const { accepted, rejectedDuplicates } = sanitizeOperations(ops);
    expect(accepted).toHaveLength(2);
    // second op survives but only with the unsuperseded id
    expect(accepted[1]).toMatchObject({ type: 'DELETE', memoryIds: ['mem3'] });
    expect(rejectedDuplicates).toBe(1);
  });

  it('drops a DELETE that is entirely consumed by prior SUPERSEDE', () => {
    const ops: DreamOperation[] = [
      {
        type: 'SUPERSEDE',
        oldMemoryId: 'mem1',
        newMemoryId: 'mem2',
      },
      {
        type: 'DELETE',
        memoryIds: ['mem1'], // all consumed
      },
    ];
    const { accepted, rejectedDuplicates } = sanitizeOperations(ops);
    expect(accepted).toHaveLength(1);
    expect(rejectedDuplicates).toBe(1);
  });

  it('handles empty input', () => {
    expect(sanitizeOperations([])).toEqual({
      accepted: [],
      rejectedDuplicates: 0,
    });
  });

  it('collapses a PROPOSE whose content near-duplicates an earlier CONSOLIDATE', () => {
    const ops: DreamOperation[] = [
      {
        type: 'CONSOLIDATE',
        sourceMemoryIds: ['a', 'b'],
        mergedKey: 'user.lang',
        mergedContent: 'the user prefers typescript over javascript',
        mergedType: 'fact',
        mergedImportance: 7,
        confidence: 0.9,
      },
      {
        type: 'PROPOSE',
        // near-duplicate of the CONSOLIDATE above (one word swap) —
        // cross-type collapse must reject it, keeping a single write.
        content: 'the user prefers typescript over python',
        key: 'insight.lang',
        memoryType: 'fact',
        importance: 5,
        confidence: 0.4,
        fromMemoryIds: ['x', 'y'],
        rationale: 'cross-group hint',
      },
    ];
    const { accepted, rejectedDuplicates } = sanitizeOperations(ops);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].type).toBe('CONSOLIDATE');
    expect(rejectedDuplicates).toBe(1);
  });

  it('does not add PROPOSE.fromMemoryIds to the superseded set', () => {
    const ops: DreamOperation[] = [
      {
        type: 'PROPOSE',
        content: 'a novel finding',
        key: 'insight.x',
        memoryType: 'fact',
        importance: 5,
        confidence: 0.4,
        fromMemoryIds: ['src1', 'src2'],
        rationale: 'why',
      },
      {
        // DELETE of one of the PROPOSE source ids must NOT be filtered,
        // because PROPOSE sources are derivation provenance, not rows
        // being retired. Only CONSOLIDATE/SUPERSEDE/DELETE add to the
        // superseded set.
        type: 'DELETE',
        memoryIds: ['src1', 'unrelated'],
      },
    ];
    const { accepted, rejectedDuplicates } = sanitizeOperations(ops);
    expect(accepted).toHaveLength(2);
    // The DELETE survives with BOTH ids intact (src1 was not superseded).
    expect(accepted[1]).toMatchObject({
      type: 'DELETE',
      memoryIds: ['src1', 'unrelated'],
    });
    expect(rejectedDuplicates).toBe(0);
  });
});
