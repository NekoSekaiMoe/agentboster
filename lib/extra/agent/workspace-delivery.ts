/**
 * Resolve where to deliver a workspace-scoped notification for a user.
 *
 * The notifications table requires a `channel` + `targetChatId` pair (the IM
 * delivery target) for every row. Workspace events aren't tied to a session
 * or an IM message thread the way L2 decisions are, so we synthesize a
 * target from the user's paired IM accounts: prefer the user's configured
 * preferredChannel, else the first paired adapter. When the user has no IM
 * account paired at all, fall back to a `web` channel + placeholder chatId
 * target so the Web inbox still receives the row — this function ALWAYS
 * returns a delivery target and never returns null.
 *
 * Best-effort by design: workspace failover must never be blocked by an
 * undeliverable notification target.
 */
import { listImAccountsForUser } from '@/lib/core/db/im-accounts';
import { getNotificationPreferences } from '@/lib/core/db/notification';

export interface WorkspaceDeliveryTarget {
  channel: string;
  targetChatId: string;
  /** IM platform user id (external — NOT a tenancy boundary). */
  targetUserId: string | null;
}

export async function resolveWorkspaceDeliveryTarget(
  userId: string,
): Promise<WorkspaceDeliveryTarget> {
  const accounts = await listImAccountsForUser(userId);
  if (accounts.length === 0) {
    // No IM paired → Web inbox only. The Web inbox reads by userId, so the
    // channel/chatId here are inert placeholders that just satisfy the
    // not-null DB constraint.
    return {
      channel: 'web',
      targetChatId: `web:${userId}`,
      targetUserId: null,
    };
  }

  const prefs = await getNotificationPreferences(userId);
  const preferred = prefs?.preferredChannel;
  const chosen =
    (preferred && accounts.find((a) => a.adapter === preferred)) || accounts[0];
  if (!chosen) {
    return {
      channel: 'web',
      targetChatId: `web:${userId}`,
      targetUserId: null,
    };
  }
  return {
    channel: chosen.adapter,
    // For 1:1 private chats the IM chat id IS the user's platform id. Group
    // chats / threads aren't resolved here — workspace events go to the
    // user's DM lane, which is the universal fallback.
    targetChatId: chosen.imUserId,
    targetUserId: chosen.imUserId,
  };
}
