import { updateSession } from '@/lib/core/db/chat';
import { t } from '@/lib/i18n/server';
import type { Locale } from '@/lib/i18n';

export async function executeModelsCommand(
  locale: Locale,
  input: {
    args: string;
    sessionId: string | null;
  },
): Promise<{ text: string }> {
  const trimmedArgs = input.args.trim();

  if (!trimmedArgs) {
    return {
      text: t(locale, 'cmd.models.usage'),
    };
  }

  if (!input.sessionId) {
    return { text: t(locale, 'cmd.models.noSession') };
  }

  const parts = trimmedArgs.split('/');
  if (parts.length !== 2) {
    return {
      text: t(locale, 'cmd.models.invalidFormat'),
    };
  }

  const [provider, model] = parts;

  try {
    await updateSession(input.sessionId, {
      metadata: {
        overrideProvider: provider,
        overrideModel: model,
      },
    });

    return { text: t(locale, 'cmd.models.success', { provider, model }) };
  } catch (error) {
    return {
      text: t(locale, 'cmd.models.failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}
