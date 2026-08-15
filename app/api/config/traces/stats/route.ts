import { cookies } from 'next/headers';

import { AuthError, requireAuthAccess } from '@/lib/auth/access';
import { getCanonicalTraceStats } from '@/lib/core/trace/dal';
import { createLogger } from '@/lib/utils/logger';

export const dynamic = 'force-dynamic';

const logger = createLogger('api.config.trace-stats');

/** Module-level short cache; acceptable to be per-instance. Writes evict
 *  expired entries first and enforce a size cap so the map cannot grow
 *  unboundedly across (userId × days) key combinations. */
const STATS_CACHE_TTL_MS = 30_000;
const STATS_CACHE_MAX_ENTRIES = 128;
const statsCache = new Map<
  string,
  { at: number; value: Awaited<ReturnType<typeof getCanonicalTraceStats>> }
>();

function evictExpiredStatsCache(now: number) {
  for (const [key, entry] of statsCache) {
    if (now - entry.at >= STATS_CACHE_TTL_MS) statsCache.delete(key);
  }
}

async function getStatsCached(userId: string | undefined, days: number) {
  const key = `${userId ?? '*'}:${days}`;
  const now = Date.now();
  const cached = statsCache.get(key);
  if (cached && now - cached.at < STATS_CACHE_TTL_MS) {
    return cached.value;
  }
  const value = await getCanonicalTraceStats({ userId, days });
  evictExpiredStatsCache(now);
  while (statsCache.size >= STATS_CACHE_MAX_ENTRIES) {
    // Drop the oldest entry (first insertion-order key).
    const oldest = statsCache.keys().next().value;
    if (oldest === undefined) break;
    statsCache.delete(oldest);
  }
  statsCache.set(key, { at: now, value });
  return value;
}

function parseDays(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(Math.max(Math.trunc(parsed), 1), 365);
}

export async function GET(request: Request) {
  try {
    const access = await requireAuthAccess(await cookies());
    const days = parseDays(new URL(request.url).searchParams.get('days'));
    const stats = await getStatsCached(
      access.isAdmin ? undefined : access.session.userId,
      days ?? 7,
    );
    return Response.json({ success: true, data: stats });
  } catch (error) {
    if (error instanceof AuthError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    logger.error('trace stats failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to fetch trace statistics' },
      { status: 500 },
    );
  }
}
