import { AuthAccess, requireAuthAccess, AuthError } from '@/lib/auth/access';
import { db } from '@/lib/core/db';
import { notifications } from '@/lib/core/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  try {
    const cookieStore = await cookies();
    let access: AuthAccess;
    try {
      access = await requireAuthAccess(cookieStore);
    } catch (error) {
      // Only AuthError carries an HTTP status (401/403). Any other throw
      // (a DB failure inside getUserById, a missing AUTH_SECRET) is a 5xx
      // and must NOT be mislabeled as 401 here — rethrow so the outer
      // catch returns a 500.
      if (error instanceof AuthError) {
        return NextResponse.json(
          { error: error.message },
          { status: error.status },
        );
      }
      throw error;
    }
    const { searchParams } = new URL(request.url);
    const channel = searchParams.get('channel');
    const read = searchParams.get('read');

    const conditions = [];
    // Scope to the caller's own notifications (admins see all).
    if (!access.isAdmin) {
      conditions.push(eq(notifications.userId, access.session.userId));
    }
    if (channel) {
      conditions.push(eq(notifications.channel, channel));
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
        payload: notifications.payload,
        channel: notifications.channel,
        status: notifications.status,
        errorMessage: notifications.errorMessage,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(notifications.createdAt))
      .limit(1000);

    const transformed = notifs.map((n) => {
      const payload = n.payload || {};
      const title = (payload.title as string) || n.type;
      const message = (payload.message as string) || n.errorMessage || '';

      return {
        id: n.id,
        type:
          n.type === 'decision'
            ? 'warning'
            : n.type === 'completion'
              ? 'success'
              : 'info',
        title,
        message,
        channel: n.channel,
        read: n.status !== 'pending',
        createdAt: n.createdAt,
      };
    });

    return NextResponse.json(transformed);
  } catch (error) {
    console.error('Failed to fetch notifications:', error);
    return NextResponse.json(
      { error: 'Failed to fetch notifications' },
      { status: 500 },
    );
  }
}
