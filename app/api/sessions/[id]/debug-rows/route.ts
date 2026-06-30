import {
  assertCanAccessOwnedResource,
  requireAuthAccess,
} from '@/lib/auth/access';
import { db, schema } from '@/lib/core/db';
import { getSession } from '@/lib/core/db/chat';
import { asc, eq } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const cookieStore = await cookies();
  let access: Awaited<ReturnType<typeof requireAuthAccess>>;
  try {
    access = await requireAuthAccess(cookieStore);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id: sessionId } = await params;
  const session = await getSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  assertCanAccessOwnedResource(access, session.userId);

  const rows = await db
    .select({
      id: schema.messages.id,
      role: schema.messages.role,
      uiMessageId: schema.messages.uiMessageId,
      stepNumber: schema.messages.stepNumber,
      createdAt: schema.messages.createdAt,
      visibleInChat: schema.messages.visibleInChat,
      hasParts: schema.messages.payload,
    })
    .from(schema.messages)
    .where(eq(schema.messages.sessionId, sessionId))
    .orderBy(
      asc(schema.messages.createdAt),
      asc(schema.messages.id),
    );

  return NextResponse.json({
    sessionId,
    rows: rows.map((r) => ({
      id: r.id,
      role: r.role,
      uiMessageId: r.uiMessageId,
      stepNumber: r.stepNumber,
      createdAt: r.createdAt.toISOString(),
      visibleInChat: r.visibleInChat,
      partTypes: Array.isArray((r.hasParts as { parts?: unknown[] }).parts)
        ? ((r.hasParts as { parts: { type: string }[] }).parts).map((p) => p.type)
        : null,
      payloadKeys: Object.keys(r.hasParts as Record<string, unknown>),
    })),
  });
}
