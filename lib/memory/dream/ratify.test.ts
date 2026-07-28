import { describe, expect, it } from 'vitest';

import {
  HIGH_CONFIDENCE_THRESHOLD,
  LONG_WINDOW_MS,
  SHORT_WINDOW_MS,
  type RatifyProposalRow,
  readyForAutoRatify,
} from './ratify';

const NOW = Date.parse('2025-01-15T12:00:00Z');

function makeProposal(
  over: Partial<RatifyProposalRow> = {},
): RatifyProposalRow {
  return {
    id: over.id ?? 'p1',
    userId: over.userId ?? 'u1',
    dreamMeta: over.dreamMeta ?? null,
  };
}

describe('readyForAutoRatify', () => {
  it('returns false when lastDreamAt is missing', () => {
    expect(
      readyForAutoRatify(makeProposal({ dreamMeta: { confidence: 0.9 } }), NOW),
    ).toBe(false);
    expect(readyForAutoRatify(makeProposal({ dreamMeta: null }), NOW)).toBe(
      false,
    );
  });

  it('returns false when lastDreamAt is unparseable', () => {
    expect(
      readyForAutoRatify(
        makeProposal({
          dreamMeta: { confidence: 0.9, lastDreamAt: 'not-a-date' },
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it('auto-promotes high-confidence proposals after SHORT_WINDOW', () => {
    const shortAgo = new Date(NOW - SHORT_WINDOW_MS - 1000).toISOString();
    expect(
      readyForAutoRatify(
        makeProposal({
          dreamMeta: {
            confidence: HIGH_CONFIDENCE_THRESHOLD,
            lastDreamAt: shortAgo,
          },
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it('does NOT auto-promote high-confidence proposals before SHORT_WINDOW', () => {
    const justBefore = new Date(NOW - SHORT_WINDOW_MS + 60_000).toISOString();
    expect(
      readyForAutoRatify(
        makeProposal({
          dreamMeta: {
            confidence: HIGH_CONFIDENCE_THRESHOLD,
            lastDreamAt: justBefore,
          },
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it('auto-promotes low-confidence proposals after LONG_WINDOW', () => {
    const longAgo = new Date(NOW - LONG_WINDOW_MS - 1000).toISOString();
    expect(
      readyForAutoRatify(
        makeProposal({
          dreamMeta: { confidence: 0.4, lastDreamAt: longAgo },
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it('does NOT auto-promote low-confidence proposals within SHORT_WINDOW..LONG_WINDOW', () => {
    // 3 days old — past SHORT but before LONG, low confidence → not ready.
    const threeDaysAgo = new Date(
      NOW - (SHORT_WINDOW_MS + 2 * 24 * 60 * 60 * 1000),
    ).toISOString();
    expect(
      readyForAutoRatify(
        makeProposal({
          dreamMeta: { confidence: 0.4, lastDreamAt: threeDaysAgo },
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it('treats missing confidence as 0 (so uses LONG_WINDOW)', () => {
    const longAgo = new Date(NOW - LONG_WINDOW_MS - 1000).toISOString();
    expect(
      readyForAutoRatify(
        makeProposal({ dreamMeta: { lastDreamAt: longAgo } }),
        NOW,
      ),
    ).toBe(true);

    const shortAgo = new Date(NOW - SHORT_WINDOW_MS - 1000).toISOString();
    expect(
      readyForAutoRatify(
        makeProposal({ dreamMeta: { lastDreamAt: shortAgo } }),
        NOW,
      ),
    ).toBe(false);
  });
});
