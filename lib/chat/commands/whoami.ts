import { getUserById } from '@/lib/core/db/users';
import { getImAccount, listImAccountsForUser } from '@/lib/core/db/im-accounts';
import type { AdapterName } from '@/types/config/channels';

export async function executeWhoamiCommand(
  adapter: AdapterName | null,
  imUserId: string | null,
): Promise<string> {
  if (!adapter || !imUserId) {
    return 'Not available outside an IM channel.';
  }

  const account = await getImAccount(adapter, imUserId);
  if (!account || account.unpairedAt) {
    return [
      'Your IM account is not bound to any ClawLess user.',
      `Adapter: ${adapter}`,
      `IM User ID: ${imUserId}`,
      'Run /pair <code> after generating a code in the Web UI.',
    ].join('\n');
  }

  const user = await getUserById(account.clawlessUserId);
  const accounts = await listImAccountsForUser(account.clawlessUserId);
  const boundChannels = accounts
    .map((a) => `${a.adapter}:${a.imUserId}`)
    .join(', ');

  const lines = [
    'Current ClawLess identity:',
    `Username: ${user?.username ?? '(unknown)'}`,
    `User ID: ${account.clawlessUserId}`,
    `Roles: ${user?.roles.join(', ') ?? '(none)'}`,
    `This IM account: ${adapter}:${imUserId}`,
    `All bound IM accounts for this user: ${boundChannels || '(none)'}`,
  ];

  return lines.join('\n');
}
