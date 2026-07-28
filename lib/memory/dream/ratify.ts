/**
 * Auto-ratification decision logic, extracted from
 * app/api/cron/dream/ratify/route.ts for testability.
 *
 * The route handler is HTTP plumbing; the decision of WHICH proposals
 * to promote belongs here so it can be unit-tested without spinning up
 * the full cron fan-out.
 *
 * Mirrors AutoGPT's `dream/ratification.py` observation window: a
 * tentative finding that survives N days without being contradicted
 * earns promotion to active. High-confidence proposals promote faster.
 */

/**
 * Confidence at/above which a proposal uses the SHORT window.
 * Below it, the LONG window applies. Calibrated so that:
 *  - Phase 2 LLM output with confidence 0.7+ is "the model was sure",
 *    so 1 day is enough observation.
 *  - Anything below 0.7 is speculative and needs a full week before
 *    auto-promotion (still auto-promoted eventually, to avoid tentative
 *    proposals accumulating forever when the user never reviews).
 */
export const HIGH_CONFIDENCE_THRESHOLD = 0.7;

/** Observation window for HIGH-confidence proposals. */
export const SHORT_WINDOW_MS = 24 * 60 * 60 * 1000; // 1 day

/** Observation window for lower-confidence proposals. */
export const LONG_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface RatifyProposalRow {
  id: string;
  userId: string;
  dreamMeta: {
    confidence?: number;
    lastDreamAt?: string;
  } | null;
}

/**
 * Decide whether a single proposal is ready for auto-promotion at `now`.
 *
 * Returns false when:
 *  - lastDreamAt is missing/unparseable (no age signal — can't decide).
 *  - age is below the applicable window.
 *
 * The cron caller is responsible for actually performing the promotion
 * via ratifyLongTermMemory(); this function ONLY decides.
 */
export function readyForAutoRatify(
  proposal: RatifyProposalRow,
  now: number,
): boolean {
  const createdAt = proposal.dreamMeta?.lastDreamAt
    ? Date.parse(proposal.dreamMeta.lastDreamAt)
    : NaN;
  if (!Number.isFinite(createdAt)) return false;

  const age = now - createdAt;
  const confidence = proposal.dreamMeta?.confidence ?? 0;
  if (confidence >= HIGH_CONFIDENCE_THRESHOLD) {
    return age >= SHORT_WINDOW_MS;
  }
  return age >= LONG_WINDOW_MS;
}
