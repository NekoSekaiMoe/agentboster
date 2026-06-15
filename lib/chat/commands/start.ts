import { getImAccount } from '@/lib/core/db/im-accounts';
import type { AdapterName } from '@/types/config/channels';
import { t } from '@/lib/i18n/server';
import type { Locale } from '@/lib/i18n';

export async function executeStartCommand(
  locale: Locale,
  options?: {
    adapter?: AdapterName | null;
    imUserId?: string | null;
  },
): Promise<{ text: string }> {
  const adapter = options?.adapter ?? null;
  const imUserId = options?.imUserId ?? null;

  if (adapter && imUserId) {
    const account = await getImAccount(adapter, imUserId);
    if (!account || account.unpairedAt) {
      return {
        text: t(locale, 'cmd.start.unpaired'),
      };
    }
  }

  return {
    text: t(locale, 'cmd.start.welcome'),
  };
}
