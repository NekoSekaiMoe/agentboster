import { describe, expect, it } from 'vitest';

import {
  USAGE_BOOST_MIN_RECALLS,
  USAGE_BOOST_MIN_UNIQUE_CONTEXTS,
  USAGE_BOOST_TARGET,
  USAGE_DEMOTE_FLOOR,
  USAGE_DEMOTE_MIN_AGE_MS,
  computeUsageAdjustments,
} from './usage-signals';

const NOW = Date.parse('2026-02-01T00:00:00Z');

function makeRow(
  overrides: Partial<
    Parameters<typeof computeUsageAdjustments>[0][number]
  > = {},
) {
  return {
    id: 'mem-1',
    sourceKind: 'user_asserted',
    importance: 5,
    recallCount: 0,
    recallQueryHashes: [],
    lastRecalledAt: null,
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function hashes(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `202601${String(i + 1).padStart(2, '0')}:abc${i}`,
  );
}

describe('computeUsageAdjustments', () => {
  it('boosts a frequently-recalled memory one step toward the target', () => {
    const adjustments = computeUsageAdjustments(
      [
        makeRow({
          recallCount: USAGE_BOOST_MIN_RECALLS,
          recallQueryHashes: hashes(USAGE_BOOST_MIN_UNIQUE_CONTEXTS),
          lastRecalledAt: new Date(NOW).toISOString(),
          importance: 6,
        }),
      ],
      NOW,
    );
    expect(adjustments).toEqual([
      { memoryId: 'mem-1', importance: 7, reason: 'frequently_recalled' },
    ]);
  });

  it('requires BOTH recall count and query diversity for a boost', () => {
    // High recall count but all from the same day+query context.
    const lowDiversity = computeUsageAdjustments(
      [
        makeRow({
          recallCount: 50,
          recallQueryHashes: hashes(1),
          lastRecalledAt: new Date(NOW).toISOString(),
        }),
      ],
      NOW,
    );
    expect(lowDiversity).toEqual([]);

    // Diverse contexts but not enough total recalls.
    const lowCount = computeUsageAdjustments(
      [
        makeRow({
          recallCount: USAGE_BOOST_MIN_RECALLS - 1,
          recallQueryHashes: hashes(10),
          lastRecalledAt: new Date(NOW).toISOString(),
        }),
      ],
      NOW,
    );
    expect(lowCount).toEqual([]);
  });

  it('never boosts tool_observed memories (taint gate)', () => {
    const adjustments = computeUsageAdjustments(
      [
        makeRow({
          sourceKind: 'tool_observed',
          recallCount: 100,
          recallQueryHashes: hashes(20),
          lastRecalledAt: new Date(NOW).toISOString(),
        }),
      ],
      NOW,
    );
    expect(adjustments).toEqual([]);
  });

  it('does not boost a memory already at or above the target', () => {
    const adjustments = computeUsageAdjustments(
      [
        makeRow({
          importance: USAGE_BOOST_TARGET,
          recallCount: 100,
          recallQueryHashes: hashes(20),
          lastRecalledAt: new Date(NOW).toISOString(),
        }),
      ],
      NOW,
    );
    expect(adjustments).toEqual([]);
  });

  it('demotes a never-recalled memory past the grace period', () => {
    const stale = new Date(NOW - USAGE_DEMOTE_MIN_AGE_MS - 1000).toISOString();
    const adjustments = computeUsageAdjustments(
      [makeRow({ importance: 6, updatedAt: stale })],
      NOW,
    );
    expect(adjustments).toEqual([
      { memoryId: 'mem-1', importance: 5, reason: 'never_recalled' },
    ]);
  });

  it('keeps recent memories out of demotion (grace period)', () => {
    const recent = new Date(NOW - 1000).toISOString();
    const adjustments = computeUsageAdjustments(
      [makeRow({ updatedAt: recent })],
      NOW,
    );
    expect(adjustments).toEqual([]);
  });

  it('never demotes below the floor', () => {
    const stale = new Date(NOW - USAGE_DEMOTE_MIN_AGE_MS - 1000).toISOString();
    const adjustments = computeUsageAdjustments(
      [makeRow({ importance: USAGE_DEMOTE_FLOOR, updatedAt: stale })],
      NOW,
    );
    expect(adjustments).toEqual([]);
  });

  it('does not demote a memory that was recalled at least once', () => {
    const stale = new Date(NOW - USAGE_DEMOTE_MIN_AGE_MS - 1000).toISOString();
    const adjustments = computeUsageAdjustments(
      [
        makeRow({
          recallCount: 1,
          lastRecalledAt: stale,
          updatedAt: stale,
        }),
      ],
      NOW,
    );
    expect(adjustments).toEqual([]);
  });

  it('handles rows with missing usage fields (legacy rows)', () => {
    const adjustments = computeUsageAdjustments(
      [
        {
          id: 'legacy-1',
          importance: 5,
          updatedAt: new Date(NOW - USAGE_DEMOTE_MIN_AGE_MS - 1000),
        },
      ],
      NOW,
    );
    // recallCount/lastRecalledAt missing → treated as never recalled → demote.
    expect(adjustments).toEqual([
      { memoryId: 'legacy-1', importance: 4, reason: 'never_recalled' },
    ]);
  });
});
