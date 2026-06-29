/**
 * Session-level SOUL.md API
 * Returns the session-specific SOUL content if set, otherwise falls back to global.
 * Used by agentd to fetch per-session SOUL overrides.
 */

import { eq } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import {
  assertCanAccessOwnedResource,
  requireAuthAccess,
} from '@/lib/auth/access';
import { db, schema } from '@/lib/core/db';
import { getSession } from '@/lib/core/db/chat';
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

  if (!provided) return false;

  // AGENTD_API_KEY supports a comma-separated list (e.g. for key rotation
  // or multiple daemons). Constant-time compare each candidate.
  const candidates = expected.split(',').map((k) => k.trim()).filter(Boolean);
  for (const candidate of candidates) {
    const a = Buffer.from(provided);
    const b = Buffer.from(candidate);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return true;
    }
  }
  return false;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await params;
    if (!hasValidAgentdApiKey(request)) {
      const cookieStore = await cookies();
      let access: Awaited<ReturnType<typeof requireAuthAccess>>;
      try {
        access = await requireAuthAccess(cookieStore);
      } catch {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      const session = await getSession(sessionId);
      if (!session) {
        return NextResponse.json(
          { error: 'Session not found' },
          { status: 404 },
        );
      }
      assertCanAccessOwnedResource(access, session.userId);
    }

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
