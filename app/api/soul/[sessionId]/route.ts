/**
 * Session-level SOUL.md API
 * Returns the session-specific SOUL content if set, otherwise falls back to global.
 * Used by agentd to fetch per-session SOUL overrides.
 */

import { eq } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { readAuthSessionFromCookies } from '@/lib/auth';
import { db, schema } from '@/lib/core/db';
import { getBuiltinMemorySection } from '@/lib/memory';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.soul.session');

function readBearerToken(value: string | null): string {
  if (!value?.startsWith('Bearer ')) {
    return '';
  }

  return value.slice('Bearer '.length);
}

function hasValidAgentdApiKey(request: Request): boolean {
  const expected = process.env.AGENTD_API_KEY;
  if (!expected) {
    return false;
  }

  const provided =
    request.headers.get('x-api-key') ||
    readBearerToken(request.headers.get('authorization'));

  return provided === expected;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    if (!hasValidAgentdApiKey(request)) {
      const cookieStore = await cookies();
      const session = await readAuthSessionFromCookies(cookieStore);
      if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
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
