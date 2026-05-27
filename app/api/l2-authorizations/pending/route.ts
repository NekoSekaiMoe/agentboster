import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { l2Authorizations } from '@/lib/db/schema';
import { eq, and, gt } from 'drizzle-orm';

export async function GET() {
  try {
    const now = new Date();

    const pending = await db
      .select()
      .from(l2Authorizations)
      .where(
        and(
          eq(l2Authorizations.status, 'pending'),
          gt(l2Authorizations.timeoutAt, now)
        )
      )
      .orderBy(l2Authorizations.requestedAt);

    return NextResponse.json(pending);
  } catch (error) {
    console.error('Failed to fetch pending authorizations:', error);
    return NextResponse.json(
      { error: 'Failed to fetch pending authorizations' },
      { status: 500 }
    );
  }
}
