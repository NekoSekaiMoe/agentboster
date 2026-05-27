import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { notifications } from '@/lib/db/schema';
import { desc, eq, and } from 'drizzle-orm';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const channel = searchParams.get('channel');
    const read = searchParams.get('read');

    const conditions = [];
    if (channel) {
      conditions.push(eq(notifications.channel, channel as 'web' | 'slack' | 'telegram' | 'email'));
    }
    if (read === 'unread') {
      conditions.push(eq(notifications.status, 'pending'));
    } else if (read === 'read') {
      conditions.push(eq(notifications.status, 'sent'));
    }

    const notifs = await db
      .select({
        id: notifications.id,
        type: notifications.notificationType,
        title: notifications.title,
        message: notifications.message,
        channel: notifications.channel,
        status: notifications.status,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(notifications.createdAt))
      .limit(1000);

    // Transform to expected format
    const transformed = notifs.map((n) => ({
      id: n.id,
      type: n.type === 'info' ? 'info' : n.type === 'warning' ? 'warning' : n.type === 'error' ? 'error' : 'success',
      title: n.title,
      message: n.message,
      channel: n.channel,
      read: n.status === 'sent',
      createdAt: n.createdAt,
    }));

    return NextResponse.json(transformed);
  } catch (error) {
    console.error('Failed to fetch notifications:', error);
    return NextResponse.json(
      { error: 'Failed to fetch notifications' },
      { status: 500 }
    );
  }
}
