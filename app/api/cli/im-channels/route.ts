/**
 * GET /api/cli/im-channels
 *
 * Returns the caller's paired IM adapters (Telegram, Discord, Slack,
 * Feishu, ...). The Desktop client uses this list to render the
 * "notify via" picker when scheduling a task: each entry maps to one
 * row in `im_accounts` where `unpaired_at IS NULL`.
 *
 * Only the fields the picker needs are returned (adapter slug, IM-side
 * user id, display name, pairing timestamp). The CLI never needs the
 * internal clawless user id or pairing secrets — those stay on the host.
 */

export const dynamic = 'force-dynamic';

import { listImAccountsForUser } from '@/lib/core/db/im-accounts';
import { withCliAuth } from '@/lib/cli/auth';

export const GET = withCliAuth(async (_req, { userId }) => {
  const accounts = await listImAccountsForUser(userId);
  return Response.json({
    ok: true,
    channels: accounts.map((a) => ({
      adapter: a.adapter,
      imUserId: a.imUserId,
      imUserName: a.imUserName,
      pairedAt: a.pairedAt.toISOString(),
    })),
  });
});
