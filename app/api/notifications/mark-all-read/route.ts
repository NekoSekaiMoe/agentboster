import { AuthAccess, requireAuthAccess, AuthError } from '@/lib/auth/access';
import { db } from '@/lib/core/db';
import { notifications } from '@/lib/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST() {
  try {
    const cookieStore = await cookies();
    let access: AuthAccess;
    try {
      access = await requireAuthAccess(cookieStore);
    } catch (error) {
      // Only AuthError carries an HTTP status (401/403). Any other throw
      // is a 5xx — rethrow so the outer catch returns 500 instead of
      // masking a DB/auth-config failure as 'Unauthorized'.
      if (error instanceof AuthError) {
        return NextResponse.json(
          { error: error.message },
          { status: error.status },
        );
      }
      throw error;
    }
    await db
      .update(notifications)
      .set({ status: 'sent' })
      .where(
        !access.isAdmin
          ? and(
              eq(notifications.status, 'pending'),
              eq(notifications.userId, access.session.userId),
            )
          : eq(notifications.status, 'pending'),
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to mark all notifications as read:', error);
    return NextResponse.json(
      { error: 'Failed to mark all notifications as read' },
      { status: 500 },
    );
  }
}
