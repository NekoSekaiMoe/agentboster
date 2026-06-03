/**
 * Session-level SOUL.md API
 * Returns the session-specific SOUL content if set, otherwise falls back to global.
 * Used by agentd to fetch per-session SOUL overrides.
 */

import { readAuthSessionFromCookies } from '@/lib/auth';
import { db, schema } from '@/lib/core/db';
import { getBuiltinMemorySection } from '@/lib/memory';
import { createLogger } from '@/lib/utils/logger';
import { eq } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

const logger = createLogger('api.soul.session');

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    const cookieStore = await cookies();
    const session = await readAuthSessionFromCookies(cookieStore);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { sessionId } = await params;

    const [sessionRow] = await db
      .select({ soulContent: schema.sessions.soulContent })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .limit(1);

    if (sessionRow?.soulContent) {
      return Response.json({
        success: true,
        data: {
          content: sessionRow.soulContent,
          scope: 'session' as const,
        },
      });
    }

    const section = await getBuiltinMemorySection('SOUL');
    return Response.json({
      success: true,
      data: {
        content: section.content,
        scope: 'global' as const,
        updatedAt: section.updatedAt,
      },
    });
  } catch (error) {
    logger.error('failed to get session soul', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        success: false,
        error: 'Failed to get session SOUL',
      },
      { status: 500 },
    );
  }
}
