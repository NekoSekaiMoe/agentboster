/**
 * Shared low-level QQ Official Bot API client.
 *
 * Used by two distinct outbound paths that previously each rolled their
 * own token cache + REST call:
 *   - `lib/bot/qq-adapter.ts` — the chat-sdk Adapter shim for
 *     streaming agent replies (postMessage / editMessage / deleteMessage).
 *   - `lib/extra/channels/notifications/qq.ts` — the notification
 *     channel for L2 decisions and completion/failover pushes.
 *
 * Auth flow: exchange `appId` + `appSecret` for an `access_token` at
 * `https://bots.qq.com/app/getAppAccessToken`, cache it locally with a
 * 60s safety margin. Send calls use the v2 Open API at
 * `https://api.sgroup.qq.com`.
 *
 * Scope is deliberately narrow: this module knows nothing about chat-sdk
 * Adapter shapes or notification payloads. It only exchanges tokens and
 * POSTs/PATCHes/DELETEs against the channel-message endpoint. Group
 * messages (`/v2/groups/{group_openid}/messages`) are not implemented —
 * see the TODO on `postChannelMessage` below.
 */

import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('bot.qq-client');

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const QQ_API = 'https://api.sgroup.qq.com';

export interface QQClientConfig {
  appId: string;
  appSecret: string;
}

interface AccessTokenResponse {
  access_token: string;
  expires_in: number;
}

interface QQMessageResponse {
  id?: string;
}

/**
 * Per-config token cache. Keyed by appId so that two separate config
 * objects with the same credentials reuse one cached token (the
 * notification channel and the bot adapter are constructed at different
 * times with different config objects but identical credentials).
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getAccessToken(cfg: QQClientConfig): Promise<string> {
  const cached = tokenCache.get(cfg.appId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      appId: cfg.appId,
      clientSecret: cfg.appSecret,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`qq oauth error: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as AccessTokenResponse;
  tokenCache.set(cfg.appId, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  });
  return data.access_token;
}

function authHeader(token: string): Record<string, string> {
  return { authorization: `QQBot ${token}` };
}

/**
 * Post a text message to a guild channel.
 *
 * @param threadId - The channel id (guild-channel addressing,
 *   `/channels/{threadId}/messages`). Group-message addressing
 *   (`/v2/groups/{group_openid}/messages`) is a separate send path not
 *   yet wired in — add a `postGroupMessage` sibling here when a
 *   deployment actually uses QQ groups.
 */
export async function postChannelMessage(
  cfg: QQClientConfig,
  threadId: string,
  content: string,
): Promise<QQMessageResponse> {
  const token = await getAccessToken(cfg);
  const resp = await fetch(`${QQ_API}/channels/${threadId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader(token) },
    body: JSON.stringify({ content }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    logger.error('qq postChannelMessage failed', {
      status: resp.status,
      body: text,
    });
    throw new Error(`qq postMessage: ${resp.status} ${text}`);
  }
  return (await resp.json()) as QQMessageResponse;
}

/**
 * Edit (PATCH) an existing channel message's content.
 */
export async function patchChannelMessage(
  cfg: QQClientConfig,
  threadId: string,
  messageId: string,
  content: string,
): Promise<QQMessageResponse> {
  const token = await getAccessToken(cfg);
  const resp = await fetch(
    `${QQ_API}/channels/${threadId}/messages/${messageId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ content }),
    },
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`qq editMessage: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as QQMessageResponse;
  // QQ's PATCH response body omits the id on some sub-resources; the
  // caller already knows the messageId it patched, so fall back to it.
  return { id: messageId ?? data.id };
}

/**
 * Delete a channel message.
 */
export async function deleteChannelMessage(
  cfg: QQClientConfig,
  threadId: string,
  messageId: string,
): Promise<void> {
  const token = await getAccessToken(cfg);
  const resp = await fetch(
    `${QQ_API}/channels/${threadId}/messages/${messageId}`,
    {
      method: 'DELETE',
      headers: authHeader(token),
    },
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`qq deleteMessage: ${resp.status} ${text}`);
  }
}
