import { NextResponse } from 'next/server';
import { db } from '@/lib/core/db';
import { notifications } from '@/lib/core/db/schema';
import { eq } from 'drizzle-orm';

export async function POST() {
  try {
    await db
      .update(notifications)
      .set({ status: 'sent' })
      .where(eq(notifications.status, 'pending'));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to mark all notifications as read:', error);
    return NextResponse.json(
      { error: 'Failed to mark all notifications as read' },
      { status: 500 }
    );
  }
}
