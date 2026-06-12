import { t } from '@/lib/i18n/server';
import type { Locale } from '@/lib/i18n';

export function executeVersionCommand(locale: Locale): { text: string } {
  const version = process.env.npm_package_version || '1.0.0';
  const nodeVersion = process.version;

  return {
    text: t(locale, 'cmd.version.text', {
      version,
      nodeVersion,
      platform: process.platform,
    }),
  };
}
