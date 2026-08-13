import { eq } from 'drizzle-orm';
import { db } from '@/lib/core/db';
import { notificationPreferences } from '@/lib/core/db/schema';

/**
 * Notification event-type → preference group mapping.
 *
 * Ported from Multica's `notifTypeToGroup` (notification_listeners.go).
 * Each notification_type maps to a coarse preference group; the user
 * mutes/unmutes at the GROUP level (not per-type). Types not in this
 * map are always delivered (not configurable) — mirrors Multica.
 *
 * agentboster's notification_type enum is {decision, completion,
 * tidy_report, workspace_failover}. They map as:
 *   - decision           → action_required  (a human verdict is pending)
 *   - completion         → agent_activity   (the agent finished something)
 *   - tidy_report        → updates          (background bookkeeping result)
 *   - workspace_failover → updates          (workspace migrated after node loss)
 *
 * Adding a new notification_type means deciding its group here. The
 * canonical group set is the union of values in this map.
 */
const NOTIF_TYPE_TO_GROUP: Readonly<Record<string, string>> = {
  decision: 'action_required',
  completion: 'agent_activity',
  tidy_report: 'updates',
  workspace_failover: 'updates',
  // Future types — keep aligned with the notification_type enum:
  //   assigned     → 'assignments'
  //   mentioned    → 'mentions'
  //   status_changed → 'status_changes'
  //   comment      → 'comments'
};

/** All canonical preference groups. */
export const NOTIFICATION_GROUPS = [
  'action_required',
  'agent_activity',
  'updates',
  'assignments',
  'mentions',
  'status_changes',
  'comments',
] as const;

export type NotificationGroup = (typeof NOTIFICATION_GROUPS)[number];

/** Resolve the preference group for a notification type. */
export function notifTypeToGroup(
  notificationType: string,
): NotificationGroup | null {
  const g = NOTIF_TYPE_TO_GROUP[notificationType];
  return (g as NotificationGroup) ?? null;
}

/** True if the notification's group is muted for the user. */
export function isNotificationMuted(input: {
  notificationType: string;
  mutedGroups: readonly string[];
}): boolean {
  const group = notifTypeToGroup(input.notificationType);
  if (!group) return false; // unconfigurable types are always delivered
  return input.mutedGroups.includes(group);
}

/**
 * Resolve the severity for a notification type. `decision` is always
 * `action_required` (a human verdict is pending); the rest default to
 * `info` unless the caller overrides via payload. This is the
 * programmatic default — callers can set severity explicitly on insert.
 */
export function defaultSeverityForType(
  notificationType: string,
): 'action_required' | 'attention' | 'info' {
  if (notificationType === 'decision') return 'action_required';
  if (notificationType === 'completion') return 'attention';
  if (notificationType === 'workspace_failover') return 'attention';
  return 'info';
}
