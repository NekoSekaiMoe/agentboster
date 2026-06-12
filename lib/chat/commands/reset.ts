import { db } from '@/lib/core/db';
import { eq } from 'drizzle-orm';
import { agentReviewLogs } from '@/lib/core/db/schema';
import { t } from '@/lib/i18n/server';
import type { Locale } from '@/lib/i18n';

export async function executeResetCommand(
  locale: Locale,
  input: {
    sessionId: string | null;
  },
): Promise<{ text: string }> {
  if (!input.sessionId) {
    return { text: t(locale, 'cmd.reset.noSession') };
  }

  try {
    // Clear any pending L2 authorization decisions for this session
    // This resets the approval/rejection memory similar to manboster's ignorance.Clear
    await db
      .delete(agentReviewLogs)
      .where(eq(agentReviewLogs.decision, 'pending_l2'));

    return { text: t(locale, 'cmd.reset.success') };
  } catch (error) {
    return {
      text: t(locale, 'cmd.reset.failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}
