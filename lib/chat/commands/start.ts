import { t } from '@/lib/i18n/server';
import type { Locale } from '@/lib/i18n';

export function executeStartCommand(locale: Locale): { text: string } {
  return {
    text: t(locale, 'cmd.start.welcome'),
  };
}
