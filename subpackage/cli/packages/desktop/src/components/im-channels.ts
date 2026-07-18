/**
 * Shared IM channel parsing for the scheduled-task pickers.
 *
 * The backend (`app/api/cli/im-channels/route.ts`) returns entries shaped as
 * `{ adapter, imUserId, imUserName, pairedAt }` — there is no `id` field.
 * Both the ScheduleView form and the SettingsPanel default-channel picker
 * consume this list, so the parsing rule lives here to avoid drift.
 */

export interface ImChannelEntry {
  /** Composite id used as the option value, e.g. `telegram:12345`. */
  id: string;
  /** Display label (prefer IM user name, fall back to adapter slug). */
  label: string;
  /** Adapter slug (`telegram`, `discord`, `slack`, `feishu`, ...). */
  adapter: string;
  /** Raw IM-side user id, when the backend provided it. */
  imUserId: string | null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Build a normalized IM channel entry from one backend record. Returns null
 * when the entry doesn't carry the fields the picker requires (adapter and
 * imUserId); entries without those fields are dropped rather than rendered
 * as incomplete rows.
 */
export function normalizeImChannel(value: unknown): ImChannelEntry | null {
  const channel = asRecord(value);

  // Some legacy paths may already pass a composite id; honor it when both
  // adapter and imUserId are present so the composite is deterministic.
  const adapter = asString(channel.adapter);
  const imUserId = asString(channel.imUserId) ?? asString(channel.id);

  if (!adapter) return null;
  if (!imUserId) return null;

  const id =
    adapter && imUserId ? `${adapter}:${imUserId}` : (imUserId ?? adapter);

  const label =
    asString(channel.imUserName) ?? asString(channel.label) ?? adapter ?? id;

  return { id, label, adapter, imUserId };
}
