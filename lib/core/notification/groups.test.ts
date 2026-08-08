import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_GROUPS,
  defaultSeverityForType,
  isNotificationMuted,
  notifTypeToGroup,
} from './groups';

describe('notifTypeToGroup', () => {
  it('maps decision → action_required', () => {
    expect(notifTypeToGroup('decision')).toBe('action_required');
  });

  it('maps completion → agent_activity', () => {
    expect(notifTypeToGroup('completion')).toBe('agent_activity');
  });

  it('maps tidy_report → updates', () => {
    expect(notifTypeToGroup('tidy_report')).toBe('updates');
  });

  it('returns null for unmapped/unknown types (always delivered)', () => {
    expect(notifTypeToGroup('unknown')).toBeNull();
    expect(notifTypeToGroup('')).toBeNull();
  });
});

describe('NOTIFICATION_GROUPS', () => {
  it('includes the canonical group set', () => {
    expect(NOTIFICATION_GROUPS).toContain('action_required');
    expect(NOTIFICATION_GROUPS).toContain('agent_activity');
    expect(NOTIFICATION_GROUPS).toContain('updates');
    expect(NOTIFICATION_GROUPS).toContain('mentions');
  });
});

describe('isNotificationMuted', () => {
  it('returns false when the type maps to no group', () => {
    expect(
      isNotificationMuted({ notificationType: 'unknown', mutedGroups: [] }),
    ).toBe(false);
    // Even if the user muted everything, unconfigurable types go through.
    expect(
      isNotificationMuted({
        notificationType: 'unknown',
        mutedGroups: ['action_required', 'agent_activity', 'updates'],
      }),
    ).toBe(false);
  });

  it('returns false when the group is not muted', () => {
    expect(
      isNotificationMuted({ notificationType: 'completion', mutedGroups: [] }),
    ).toBe(false);
  });

  it('returns true when the group is muted', () => {
    // User muted agent_activity — completion events should be suppressed.
    expect(
      isNotificationMuted({
        notificationType: 'completion',
        mutedGroups: ['agent_activity'],
      }),
    ).toBe(true);
  });

  it('lets the user mute one group while keeping another', () => {
    // The key capability: mute agent_activity, keep action_required.
    const muted = ['agent_activity'];
    expect(
      isNotificationMuted({
        notificationType: 'completion',
        mutedGroups: muted,
      }),
    ).toBe(true);
    expect(
      isNotificationMuted({ notificationType: 'decision', mutedGroups: muted }),
    ).toBe(false);
  });

  it('action_required (decision) is never auto-muted by muting agent_activity', () => {
    // These are distinct groups — important so that muting routine
    // agent noise never silences a pending L2 authorization.
    expect(
      isNotificationMuted({
        notificationType: 'decision',
        mutedGroups: ['agent_activity', 'updates'],
      }),
    ).toBe(false);
  });
});

describe('defaultSeverityForType', () => {
  it('decision is action_required (pending human verdict)', () => {
    expect(defaultSeverityForType('decision')).toBe('action_required');
  });

  it('completion is attention', () => {
    expect(defaultSeverityForType('completion')).toBe('attention');
  });

  it('everything else is info', () => {
    expect(defaultSeverityForType('tidy_report')).toBe('info');
    expect(defaultSeverityForType('unknown')).toBe('info');
  });
});
