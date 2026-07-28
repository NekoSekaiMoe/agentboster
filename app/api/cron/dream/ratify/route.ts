/**
 * Auto-ratify cron — promote well-aged Dream proposals to active.
 *
 * Mirrors AutoGPT's `dream/ratification.py` observation window: a
 * tentative finding that survives N days without being contradicted
 * (rejected by the user OR superseded by a newer consolidation) earns
 * promotion to active. High-confidence proposals promote faster.
 *
 * Triggered by the same external cron as /api/cron/dream, on a slower
 * cadence (weekly is plenty — the observation window is days, not
 * minutes). Suggested vercel.json entry:
 *   { "path": "/api/cron/dream/ratify", "schedule": "0 4 * * 0" }
 *
 * Auth: CRON_SECRET, verified via hasValidCronSecret.
 *
 * The decision logic (which proposals are "ready") lives in
 * lib/memory/dream/ratify.ts so it can be unit-tested independently.
 */

import { NextResponse } from 'next/server';

import {
  listTentativeMemories,
  ratifyLongTermMemory,
} from '@/lib/core/db/memory/long-term';
import {
  type RatifyProposalRow,
  readyForAutoRatify,
} from '@/lib/memory/dream/ratify';
import { hasValidCronSecret } from '@/lib/security/cron-auth';
import { createLogger } from '@/lib/utils/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const logger = createLogger('api.cron.dream.ratify');

export async function POST(request: Request): Promise<Response> {
  if (!hasValidCronSecret(request as never)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // The cron runs across all users (same fan-out model as /api/cron/dream).
  // listDistinctTentativeUserIds lets us fan out per-user without scanning
  // every tentative row in JS.
  const { listDistinctTentativeUserIds } = await import(
    '@/lib/core/db/memory/long-term'
  );
  const userIds = await listDistinctTentativeUserIds();
  if (userIds.length === 0) {
    return NextResponse.json({ ok: true, promoted: 0, users: 0 });
  }

  const now = Date.now();
  let totalPromoted = 0;
  const perUser: Array<{ userId: string; promoted: number; skipped: number }> =
    [];

  for (const userId of userIds) {
    const proposals = (await listTentativeMemories({
      userId,
      limit: 200,
    })) as RatifyProposalRow[];
    let promoted = 0;
    let skipped = 0;

    for (const proposal of proposals) {
      if (!readyForAutoRatify(proposal, now)) {
        skipped += 1;
        continue;
      }
      const ok = await ratifyLongTermMemory({
        id: proposal.id,
        userId,
        ratified: true,
      }).catch(() => null);
      if (ok) promoted += 1;
    }

    if (promoted > 0) {
      // Invalidate caches for this user so the next prompt sees the
      // newly-active memories.
      const { invalidateRecallCache } = await import('@/lib/memory/recall');
      const { invalidateProfileCache } = await import('@/lib/memory/profile');
      invalidateRecallCache(userId);
      await invalidateProfileCache(userId);
    }

    totalPromoted += promoted;
    perUser.push({ userId, promoted, skipped });
  }

  logger.info('cron:ratify_done', {
    users: userIds.length,
    promoted: totalPromoted,
  });

  return NextResponse.json({
    ok: true,
    users: userIds.length,
    promoted: totalPromoted,
    perUser,
  });
}

export const GET = POST;
