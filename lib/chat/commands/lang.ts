import { getSession, updateSession } from '@/lib/core/db/chat';
import { t, locales, localeLabels, type Locale } from '@/lib/i18n/server';

export async function executeLangCommand(
  locale: Locale,
  input: {
    args: string;
    sessionId: string | null;
  },
): Promise<{
  text: string;
  shouldShowSelector?: boolean;
  options?: Array<{ value: string; label: string }>;
}> {
  const trimmedArgs = input.args.trim();

  // If no args, show language selector
  if (!trimmedArgs) {
    return {
      text: t(locale, 'cmd.lang.prompt'),
      shouldShowSelector: true,
      options: locales.map((loc) => ({
        value: loc,
        label: localeLabels[loc],
      })),
    };
  }

  // If args provided, try to set language
  const newLocale = trimmedArgs as Locale;
  if (!locales.includes(newLocale)) {
    return {
      text: t(locale, 'cmd.lang.failed', { error: 'Invalid language code' }),
    };
  }

  if (!input.sessionId) {
    return {
      text: t(locale, 'cmd.lang.failed', { error: 'No active session' }),
    };
  }

  try {
    // Merge with existing metadata — updateSession overwrites the whole
    // jsonb column, so `{ locale }` alone would wipe `source`,
    // `contextUsage`, `latestApproval`, etc. Read first, then merge.
    const existing = await getSession(input.sessionId);
    await updateSession(input.sessionId, {
      metadata: {
        ...(existing?.metadata ?? {}),
        locale: newLocale,
      },
    });

    return {
      text: t(newLocale, 'cmd.lang.success', {
        language: localeLabels[newLocale],
      }),
    };
  } catch (error) {
    return {
      text: t(locale, 'cmd.lang.failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}
