import {
  getNotificationPreferences,
  upsertNotificationPreferences,
} from '@/lib/core/db/notification';
import { getNotificationManager } from '@/lib/extra/channels/notification-manager';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get('user_id');
  const type = searchParams.get('type');

  if (type === 'health') {
    const mgr = getNotificationManager();
    const health = mgr.getAllChannelHealth();
    return Response.json({ success: true, data: health });
  }

  if (userId) {
    const prefs = await getNotificationPreferences(userId);
    return Response.json({ success: true, data: prefs });
  }

  return Response.json(
    { success: false, error: 'Missing user_id or type=health' },
    { status: 400 },
  );
}

export async function PUT(request: Request) {
  const body = await request.json();
  const { userId, preferredChannel, fallbackChannels, enabled } = body;

  if (!userId || !preferredChannel) {
    return Response.json(
      { success: false, error: 'Missing userId or preferredChannel' },
      { status: 400 },
    );
  }

  const prefs = await upsertNotificationPreferences({
    userId,
    preferredChannel,
    fallbackChannels: fallbackChannels ?? [],
    enabled: enabled ?? true,
  });

  return Response.json({ success: true, data: prefs });
}
