import { readAuthSessionFromCookies } from '@/lib/auth';
import { db, schema } from '@/lib/core/db';
import { and, eq, gte } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const cookieStore = await cookies();
    const session = await readAuthSessionFromCookies(cookieStore);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id: sessionId } = await params;
    const body = await request.json();
    const messageId = body.message_id;

    if (!messageId) {
      return NextResponse.json(
        { error: 'message_id is required' },
        { status: 400 }
      );
    }

    const [message] = await db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.id, messageId),
          eq(schema.messages.sessionId, sessionId)
        )
      )
      .limit(1);

    if (!message) {
      return NextResponse.json(
        { error: 'Message not found' },
        { status: 404 }
      );
    }

    await db
      .delete(schema.messages)
      .where(
        and(
          eq(schema.messages.sessionId, sessionId),
          gte(schema.messages.createdAt, message.createdAt)
        )
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to revert session:', error);
    return NextResponse.json(
      { error: 'Failed to revert session' },
      { status: 500 }
    );
  }
}
