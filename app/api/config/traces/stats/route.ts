import { cookies } from 'next/headers';

import { AuthError, requireAuthAccess } from '@/lib/auth/access';
import { getCanonicalTraceStats } from '@/lib/core/trace/dal';
import { createLogger } from '@/lib/utils/logger';

export const dynamic = 'force-dynamic';

const logger = createLogger('api.config.trace-stats');

/** Module-level short cache; acceptable to be per-instance. */
const STATS_CACHE_TTL_MS = 30_000;
const statsCache = new Map<
  string,
  { at: number; value: Awaited<ReturnType<typeof getCanonicalTraceStats>> }
>();

async function getStatsCached(userId: string | undefined, days: number) {
  const key = `${userId ?? '*'}:${days}`;
  const cached = statsCache.get(key);
  if (cached && Date.now() - cached.at < STATS_CACHE_TTL_MS) {
    return cached.value;
  }
  const value = await getCanonicalTraceStats({ userId, days });
  statsCache.set(key, { at: Date.now(), value });
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
