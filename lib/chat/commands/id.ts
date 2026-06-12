import { t } from '@/lib/i18n/server';
import type { Locale } from '@/lib/i18n';

export function executeIdCommand(
  locale: Locale,
  input: {
    sessionId: string | null;
    userId: string | null;
    source: { adapter?: string; threadId?: string } | null;
  },
): { text: string } {
  const lines = [t(locale, 'cmd.id.title')];

  if (input.sessionId) {
    lines.push(t(locale, 'cmd.id.sessionId', { value: input.sessionId }));
  } else {
    lines.push(t(locale, 'cmd.id.noSession'));
  }

  if (input.userId) {
    lines.push(t(locale, 'cmd.id.userId', { value: input.userId }));
  }

  if (input.source?.adapter) {
    lines.push(t(locale, 'cmd.id.adapter', { value: input.source.adapter }));
  }

  if (input.source?.threadId) {
    lines.push(t(locale, 'cmd.id.threadId', { value: input.source.threadId }));
  }

  return { text: lines.join('\n') };
}
