import {
  listSessions,
  listSessionsByExternalThreadIds,
} from '@/lib/core/db/chat';
import { createLogger } from '@/lib/utils/logger';
import { type Locale, isLocale } from '@/lib/i18n';

const logger = createLogger('chat.user_locale');

/**
 * Best-effort lookup of a user's preferred locale.
 *
 * The locale is stored on the session record's metadata.locale field
 * (written by the /lang command). We pick the most recently updated
 * session for the user and read its locale.
 *
 * Returns null when no preference is recorded. Callers should fall
 * back to the global default (config.language?.bot_locale or 'auto').
 *
 * This is the central read path for IM/notify locale resolution —
 * keep it cheap and side-effect-free.
 */
export async function resolveUserLocale(
  userId: string,
): Promise<Locale | null> {
  if (!userId) return null;

  try {
    const sessions = await listSessions({
      userId,
      archived: false,
      limit: 10,
    });
    for (const session of sessions) {
      const locale = readLocaleFromMetadata(session?.metadata);
      if (locale) return locale;
    }
  } catch (error) {
    logger.warn('resolve_user_locale_failed', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}

/**
 * Best-effort lookup of an IM thread's preferred locale.
 *
 * IM threads are identified by the (adapter, threadId) tuple, which
 * maps to sessions.external_thread_id. Used by the IM inbound path
 * (lib/bot) where we have a threadId but not yet a resolved userId.
 */
export async function resolveThreadLocale(
  externalThreadIds: string[],
): Promise<Locale | null> {
  const ids = externalThreadIds.filter((id) => id && id.trim().length > 0);
  if (ids.length === 0) return null;

  try {
    const sessions = await listSessionsByExternalThreadIds(ids);
    for (const session of sessions) {
      const locale = readLocaleFromMetadata(session?.metadata);
      if (locale) return locale;
    }
  } catch (error) {
    logger.warn('resolve_thread_locale_failed', {
      threadIds: ids,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}

/**
 * Read a Locale from a session metadata blob. Accepts both a top-level
 * `locale` field and the value 'auto' (which we treat as null so the
 * caller falls back rather than forcing English).
 */
function readLocaleFromMetadata(metadata: unknown): Locale | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>).locale;
  if (typeof value !== 'string' || value.length === 0 || value === 'auto') {
    return null;
  }
  return isLocale(value) ? value : null;
}
