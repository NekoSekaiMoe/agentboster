import { pauseWorkflow } from '@/lib/workflow/agent/dispatch';
import { t } from '@/lib/i18n/server';
import type { Locale } from '@/lib/i18n';

export async function executeCancelCommand(
  locale: Locale,
  input: {
    sessionId: string | null;
    runId: string | null;
  },
): Promise<{ text: string }> {
  if (!input.sessionId) {
    return { text: t(locale, 'cmd.cancel.noSession') };
  }

  if (!input.runId) {
    return { text: t(locale, 'cmd.cancel.noRun') };
  }

  try {
    await pauseWorkflow(input.runId);
    return { text: t(locale, 'cmd.cancel.success') };
  } catch (error) {
    return {
      text: t(locale, 'cmd.cancel.failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}
