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

  const adapter = asString(channel.adapter);
  if (!adapter) return null;

  // Backend (app/api/cli/im-channels/route.ts) returns entries shaped
  // `{ adapter, imUserId, imUserName, pairedAt }` with NO composite id.
  // Some legacy paths may already pass a composite `id` like
  // "telegram:12345" (e.g. cached localStorage state from older
  // builds). If we prepend `${adapter}:` again we'd get
  // "telegram:telegram:12345" and break saved selections.
  //
  // Detect the legacy composite by checking whether the candidate
  // value already starts with `<adapter>:`; if so, preserve it as-is.
  // Otherwise build the canonical `<adapter>:<imUserId>` form.
  const rawImUserId = asString(channel.imUserId) ?? asString(channel.id);
  if (!rawImUserId) return null;

  const hasAdapterPrefix = rawImUserId.startsWith(`${adapter}:`);
  const imUserId = rawImUserId;
  const id = hasAdapterPrefix ? imUserId : `${adapter}:${imUserId}`;

  const label =
    asString(channel.imUserName) ?? asString(channel.label) ?? adapter ?? id;

  return { id, label, adapter, imUserId };
}
