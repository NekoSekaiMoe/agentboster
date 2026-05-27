import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { l2Authorizations } from '@/lib/db/schema';
import { eq, inArray } from 'drizzle-orm';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { sessionIds } = body;

    if (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length === 0) {
      return NextResponse.json(
        { error: 'sessionIds must be a non-empty array' },
        { status: 400 }
      );
    }

    const now = new Date();

    await db
      .update(l2Authorizations)
      .set({
        status: 'approved',
        decidedAt: now,
        decidedBy: 'admin',
      })
      .where(
        and(
          inArray(l2Authorizations.sessionId, sessionIds),
          eq(l2Authorizations.status, 'pending')
        )
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to approve authorizations:', error);
    return NextResponse.json(
      { error: 'Failed to approve authorizations' },
      { status: 500 }
    );
  }
}
