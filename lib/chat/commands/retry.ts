import { t } from '@/lib/i18n/server';
import type { Locale } from '@/lib/i18n';

export async function executeRetryCommand(
  locale: Locale,
  input: {
    sessionId: string | null;
  },
): Promise<{ shouldRetry: boolean; text?: string }> {
  if (!input.sessionId) {
    return { shouldRetry: false, text: t(locale, 'cmd.retry.noSession') };
  }

  // Signal that we should regenerate the last response
  // The actual retry will be handled by the chatMain flow
  return { shouldRetry: true };
}
