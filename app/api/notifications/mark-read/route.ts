import { AuthAccess, requireAuthAccess, AuthError } from '@/lib/auth/access';
import { db } from '@/lib/core/db';
import { notifications } from '@/lib/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const cookieStore = await cookies();
    let access: AuthAccess;
    try {
      access = await requireAuthAccess(cookieStore);
    } catch (error) {
      const status = error instanceof AuthError ? error.status : 401;
      return NextResponse.json({ error: 'Unauthorized' }, { status });
    }
    const body = await request.json();
    const { ids } = body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json(
        { error: 'ids must be a non-empty array' },
        { status: 400 },
      );
    }

    await db
      .update(notifications)
      .set({ status: 'sent' })
      .where(
        !access.isAdmin
          ? and(
              inArray(notifications.id, ids),
              eq(notifications.userId, access.session.userId),
            )
          : inArray(notifications.id, ids),
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to mark notifications as read:', error);
    return NextResponse.json(
      { error: 'Failed to mark notifications as read' },
      { status: 500 },
    );
  }
}
