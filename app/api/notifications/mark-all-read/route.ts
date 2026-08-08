import { requireAuthAccess, AuthError } from '@/lib/auth/access';
import { db } from '@/lib/core/db';
import { notifications } from '@/lib/core/db/schema';
import { eq } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST() {
  try {
    const cookieStore = await cookies();
    try {
      await requireAuthAccess(cookieStore);
    } catch (error) {
      const status = error instanceof AuthError ? error.status : 401;
      return NextResponse.json({ error: 'Unauthorized' }, { status });
    }
    await db
      .update(notifications)
      .set({ status: 'sent' })
      .where(eq(notifications.status, 'pending'));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to mark all notifications as read:', error);
    return NextResponse.json(
      { error: 'Failed to mark all notifications as read' },
      { status: 500 },
    );
  }
}
