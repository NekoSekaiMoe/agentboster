/**
 * Tests for the pure-function parts of Phase 2 (cosine, sampleGroup,
 * groupByPrefix, selectCandidatePairs). The LLM-driven recombine path
 * is exercised only via integration tests — here we lock down the
 * combinatorics + threshold logic that selects which pairs the model
 * gets to see.
 */

import { describe, expect, it } from 'vitest';

import {
  type MemoryRow,
  cosine,
  groupByPrefix,
  sampleGroup,
  selectCandidatePairs,
} from './phase2-recombine';

function makeMemory(over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: over.id ?? 'id',
    userId: over.userId ?? 'u1',
    projectId: over.projectId ?? '__global__',
    // Allow callers to explicitly pass key: null (otherwise default).
    key: over.key === undefined ? 'k' : over.key,
    content: over.content ?? 'content',
    memoryType: over.memoryType ?? 'fact',
    importance: over.importance ?? 5,
  };
}

describe('cosine', () => {
  it('returns 0 when either vector is null or empty', () => {
    expect(cosine(null, [1, 2])).toBe(0);
    expect(cosine([1, 2], null)).toBe(0);
    expect(cosine([], [])).toBe(0);
  });

  it('returns 0 when dimensions mismatch', () => {
    expect(cosine([1, 2, 3], [1, 2])).toBe(0);
  });

  it('returns 1 for identical vectors', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('returns a value in [0, 1] for positively-correlated vectors', () => {
    // cos([1,1],[1,0]) = 1/sqrt(2) ≈ 0.707
    expect(cosine([1, 1], [1, 0])).toBeCloseTo(Math.SQRT1_2, 3);
  });
});

describe('groupByPrefix', () => {
  it('groups by the substring before the first dot', () => {
    const groups = groupByPrefix([
      makeMemory({ id: '1', key: 'user.lang' }),
      makeMemory({ id: '2', key: 'user.location' }),
      makeMemory({ id: '3', key: 'project.stack' }),
    ]);
    expect(Array.from(groups.keys()).sort()).toEqual(['project', 'user']);
    expect(groups.get('user')?.map((m) => m.id)).toEqual(['1', '2']);
    expect(groups.get('project')?.map((m) => m.id)).toEqual(['3']);
  });

  it('treats keys without a dot as their own prefix', () => {
    const groups = groupByPrefix([makeMemory({ id: '1', key: 'plain' })]);
    expect(groups.get('plain')?.map((m) => m.id)).toEqual(['1']);
  });

  it('skips memories without a key', () => {
    const groups = groupByPrefix([
      makeMemory({ id: '1', key: null }),
      makeMemory({ id: '2', key: 'user.lang' }),
    ]);
    expect(groups.size).toBe(1);
    expect(groups.has('user')).toBe(true);
  });
});

describe('sampleGroup', () => {
  it('returns the top-SAMPLE_PER_GROUP by importance', () => {
    const members = [
      makeMemory({ id: 'a', importance: 3 }),
      makeMemory({ id: 'b', importance: 9 }),
      makeMemory({ id: 'c', importance: 5 }),
      makeMemory({ id: 'd', importance: 7 }),
      makeMemory({ id: 'e', importance: 10 }),
    ];
    const sampled = sampleGroup(members);
    // SAMPLE_PER_GROUP = 3
    expect(sampled.map((m) => m.id)).toEqual(['e', 'b', 'd']);
  });
});

describe('selectCandidatePairs', () => {
  it('keeps only pairs at or above the similarity threshold, ranked desc', () => {
    const groups = new Map<
      string,
      { memory: MemoryRow; embedding: number[] | null }[]
    >([
      [
        'user',
        [
          {
            memory: makeMemory({ id: 'u1', content: 'a' }),
            embedding: [1, 0],
          },
        ],
      ],
      [
        'project',
        [
          {
            memory: makeMemory({ id: 'p1', content: 'b' }),
            // sim with u1 = cos([1,0],[1,0]) = 1.0
            embedding: [1, 0],
          },
          {
            memory: makeMemory({ id: 'p2', content: 'c' }),
            // sim with u1 = cos([1,0],[0,1]) = 0 (below threshold)
            embedding: [0, 1],
          },
        ],
      ],
    ]);

    const pairs = selectCandidatePairs(groups);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].a.id).toBe('u1');
    expect(pairs[0].b.id).toBe('p1');
    expect(pairs[0].similarity).toBeCloseTo(1, 6);
  });

  it('skips pairs within the same group', () => {
    const groups = new Map<
      string,
      { memory: MemoryRow; embedding: number[] | null }[]
    >([
      [
        'user',
        [
          {
            memory: makeMemory({ id: 'u1' }),
            embedding: [1, 0],
          },
          {
            memory: makeMemory({ id: 'u2' }),
            embedding: [1, 0],
          },
        ],
      ],
    ]);
    // Only one group → no cross-group pairs possible.
    expect(selectCandidatePairs(groups)).toHaveLength(0);
  });

  it('returns empty when embeddings are null (no signal)', () => {
    const groups = new Map<
      string,
      { memory: MemoryRow; embedding: number[] | null }[]
    >([
      ['user', [{ memory: makeMemory({ id: 'u1' }), embedding: null }]],
      ['project', [{ memory: makeMemory({ id: 'p1' }), embedding: null }]],
    ]);
    expect(selectCandidatePairs(groups)).toHaveLength(0);
  });

  it('caps the result to MAX_CANDIDATE_PAIRS', () => {
    // 3 groups × 3 members, all parallel vectors → 3 group-pairs ×
    // 3×3 member pairs = 27 cross-group candidate pairs, all sim=1.
    // Cap (8) should kick in, so pairs.length is exactly 8.
    const groups = new Map<
      string,
      { memory: MemoryRow; embedding: number[] | null }[]
    >();
    let n = 0;
    for (const prefix of ['a', 'b', 'c']) {
      groups.set(
        prefix,
        [0, 1, 2].map(() => ({
          memory: makeMemory({ id: `m${n++}` }),
          embedding: [1, 0],
        })),
      );
    }
    const pairs = selectCandidatePairs(groups);
    expect(pairs).toHaveLength(8);
  });
});
