import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { l2Authorizations } from '@/lib/db/schema';
import { desc } from 'drizzle-orm';

export async function GET() {
  try {
    const history = await db
      .select()
      .from(l2Authorizations)
      .orderBy(desc(l2Authorizations.decidedAt))
      .limit(1000);

    return NextResponse.json(history);
  } catch (error) {
    console.error('Failed to fetch authorization history:', error);
    return NextResponse.json(
      { error: 'Failed to fetch authorization history' },
      { status: 500 }
    );
  }
}
