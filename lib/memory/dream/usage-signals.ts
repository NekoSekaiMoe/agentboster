/**
 * Usage-feedback signals for Dream (OpenClaw deep-ranking analogue).
 *
 * OpenClaw's dreaming promotes memory "because it kept being useful, not
 * because it was written confidently" — recall frequency, query
 * diversity, and recency are the ranking signals. This module is the
 * deterministic half of that idea for agentboster: it reads the usage
 * counters the recall path maintains (recall_count, recall_query_hashes,
 * last_recalled_at) and emits importance adjustments WITHOUT any model
 * call. The LLM half (phase 1 prompt annotations) sees the same stats.
 *
 * Deterministic gates, model judgment inside them:
 *  - BOOST: a fact recalled many times across many distinct day+query
 *    contexts has proven utility → importance floor rises.
 *  - DEMOTE: a fact never recalled after a long grace period is likely
 *    write-time noise → importance sinks (it can still be recalled, it
 *    just stops competing with proven-useful facts).
 *  - Taint gate: tool_observed rows are never boosted — recall frequency
 *    must not launder unverified external content into high-importance
 *    (and from there into the always-on profile).
 */

/** Minimum total recalls before a memory is eligible for a boost. */
export const USAGE_BOOST_MIN_RECALLS = 5;
/** Minimum distinct day+query contexts for a boost (query diversity). */
export const USAGE_BOOST_MIN_UNIQUE_CONTEXTS = 3;
/** Importance ceiling a boost can raise a memory TO (never above). */
export const USAGE_BOOST_TARGET = 8;
/** Grace period before a never-recalled memory may be demoted. */
export const USAGE_DEMOTE_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Importance floor a demote can lower a memory TO (never below). */
export const USAGE_DEMOTE_FLOOR = 3;

export interface UsageSignalRow {
  id: string;
  sourceKind?: string | null;
  importance: number;
  recallCount?: number | null;
  recallQueryHashes?: string[] | null;
  lastRecalledAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

export interface UsageAdjustment {
  memoryId: string;
  /** New importance (always a ±1 step from the current value). */
  importance: number;
  reason: 'frequently_recalled' | 'never_recalled';
}

function toTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * Compute deterministic importance adjustments from usage counters.
 * Pure function — unit-tested directly, called by Dream phase 1 with the
 * same prefetched row set the other phases use.
 *
 * Adjustments are single steps (±1) per Dream run: a nightly sweep that
 * walks importance gradually is far more robust to a noisy burst of
 * recalls (e.g. one long session hammering one fact) than jumping
 * straight to the ceiling.
 */
export function computeUsageAdjustments(
  rows: UsageSignalRow[],
  now: number = Date.now(),
): UsageAdjustment[] {
  const adjustments: UsageAdjustment[] = [];

  for (const row of rows) {
    const recallCount = row.recallCount ?? 0;
    const uniqueContexts = Array.isArray(row.recallQueryHashes)
      ? row.recallQueryHashes.length
      : 0;

    // BOOST gate: proven utility across many distinct contexts. Skips
    // tool_observed (taint) and rows already at/above the target.
    if (
      row.sourceKind !== 'tool_observed' &&
      recallCount >= USAGE_BOOST_MIN_RECALLS &&
      uniqueContexts >= USAGE_BOOST_MIN_UNIQUE_CONTEXTS &&
      row.importance < USAGE_BOOST_TARGET
    ) {
      adjustments.push({
        memoryId: row.id,
        importance: row.importance + 1,
        reason: 'frequently_recalled',
      });
      continue;
    }

    // DEMOTE gate: never recalled, well past the grace period, and still
    // above the floor. Uses updatedAt (not createdAt) so a recently
    // refreshed fact gets a fresh grace window.
    const updatedAt = toTime(row.updatedAt);
    if (
      recallCount === 0 &&
      !toTime(row.lastRecalledAt) &&
      updatedAt !== null &&
      now - updatedAt >= USAGE_DEMOTE_MIN_AGE_MS &&
      row.importance > USAGE_DEMOTE_FLOOR
    ) {
      adjustments.push({
        memoryId: row.id,
        importance: row.importance - 1,
        reason: 'never_recalled',
      });
    }
  }

  return adjustments;
}
