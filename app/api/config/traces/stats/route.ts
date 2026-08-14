import { cookies } from 'next/headers';

import { AuthError, requireAuthAccess } from '@/lib/auth/access';
import { getCanonicalTraceStats } from '@/lib/core/trace/dal';
import { createLogger } from '@/lib/utils/logger';

export const dynamic = 'force-dynamic';

const logger = createLogger('api.config.trace-stats');

export async function GET() {
  try {
    const access = await requireAuthAccess(await cookies());
    const stats = await getCanonicalTraceStats({
      userId: access.isAdmin ? undefined : access.session.userId,
    });
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
