import { cookies } from 'next/headers';

import { AuthError, requireAuthAccess } from '@/lib/auth/access';
import { listTraces } from '@/lib/core/trace/query';
import { createLogger } from '@/lib/utils/logger';

export const dynamic = 'force-dynamic';

const logger = createLogger('api.config.traces');

function parseLimit(value: string | null): number {
  const parsed = Number(value ?? 100);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(Math.max(Math.trunc(parsed), 1), 250);
}

export async function GET(request: Request) {
  try {
    const access = await requireAuthAccess(await cookies());
    const { searchParams } = new URL(request.url);
    const traces = await listTraces(
      { userId: access.isAdmin ? undefined : access.session.userId },
      {
        limit: parseLimit(searchParams.get('limit')),
        search: searchParams.get('search') ?? undefined,
      },
    );

    return Response.json({ success: true, data: traces });
  } catch (error) {
    if (error instanceof AuthError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    logger.error('trace list failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to fetch traces' },
      { status: 500 },
    );
  }
}
