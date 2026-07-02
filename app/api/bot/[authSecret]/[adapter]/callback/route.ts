import { getBot } from '@/lib/bot/index';
import { isValidBotSecret } from '@/lib/bot/webhook';
import {
  decryptWecomPayload,
  verifyWecomSignature,
} from '@/lib/bot/wecom-crypto';
import { getConfig } from '@/lib/core/kv/config';
import { createLogger } from '@/lib/utils/logger';
import type { AdapterName } from '@/types/config/channels';
import { after } from 'next/server';
import { NextRequest, NextResponse } from 'next/server';
import { createDecipheriv, createHash } from 'node:crypto';

const logger = createLogger('api.bot.webhook');

const CHAT_SDK_ADAPTERS = ['slack', 'teams', 'gchat', 'telegram', 'discord'];

// IM webhook handlers process the agent's full streamed reply in the
// background via `after()`. The agent run can take much longer than the
// default function maxDuration (10s), which would abort the stream
// consumer mid-flight and truncate the IM message. Raise the ceiling so
// the after-task has room to drain the stream. On Hobby this clamps to
// 10s, Pro to 60s (or 300s with Fluid compute), Enterprise to 900s.
export const maxDuration = 300;

async function handleChatSdkWebhook(
  adapterName: AdapterName,
  request: NextRequest,
): Promise<Response> {
  try {
    const bot = await getBot();

    // Use chat.webhooks[adapterName] instead of bot.getAdapter().handleWebhook()
    // to ensure Chat.ensureInitialized() runs first (sets adapter.chat reference).
    // Without this, adapters reject webhooks with "Chat instance not initialized".
    const webhookHandler =
      bot.webhooks[adapterName as keyof typeof bot.webhooks];
    if (!webhookHandler) {
      return NextResponse.json(
        { error: `Adapter ${adapterName} not configured or enabled` },
        { status: 404 },
      );
    }

    const result = await webhookHandler(request, {
      waitUntil: (p) => after(() => p),
    });

    if (result instanceof Response) {
      return result;
    }
    return NextResponse.json(result ?? { ok: true });
  } catch (error) {
    console.error(`[bot/webhook] ${adapterName} callback error:`, error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

/**
 * Decrypt a Feishu v2 event payload encrypted with AES-256-CBC.
 *
 * Feishu's protocol (when encrypt_key is configured on the app):
 *   - The webhook body is `{ "encrypt": "<base64 blob>" }` instead of
 *     the plaintext event JSON.
 *   - The AES key is SHA256(encrypt_key) (32 bytes).
 *   - The base64 blob decodes to `iv(16 bytes) || ciphertext`.
 *   - Algorithm: AES-256-CBC, PKCS7 padding.
 *
 * When encrypt_key is not configured on the Feishu app, the webhook
 * body is the plaintext event JSON and this function is not called.
 *
 * Returns the decrypted event object, or null if decryption fails
 * (wrong key, malformed payload). The caller treats null as "treat
 * the body as plaintext" for backward compatibility with apps that
 * haven't enabled encryption.
 */
function decryptFeishuPayload(
  encryptBlob: string,
  encryptKey: string,
): Record<string, unknown> | null {
  try {
    const key = createHash('sha256').update(encryptKey).digest();
    const blob = Buffer.from(encryptBlob, 'base64');
    if (blob.length < 32) return null;
    const iv = blob.subarray(0, 16);
    const ciphertext = blob.subarray(16);
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(decrypted) as Record<string, unknown>;
  } catch (err) {
    logger.warn('feishu payload decryption failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function handleFeishuWebhook(
  request: NextRequest,
): Promise<NextResponse> {
  try {
    let body = await request.json().catch(() => ({}));

    // Decrypt the payload if Feishu is configured with an encrypt_key.
    // Without this branch, an app that has encryption enabled would
    // receive { encrypt: "..." } and silently fail to match any event
    // type — inbound messages would never reach the agent.
    const config = await getConfig();
    const feishuCfg = config.channels?.feishu;
    if (
      feishuCfg?.encrypt_key &&
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { encrypt?: unknown }).encrypt === 'string'
    ) {
      const decrypted = decryptFeishuPayload(
        (body as { encrypt: string }).encrypt,
        feishuCfg.encrypt_key,
      );
      if (decrypted) {
        body = decrypted;
      } else {
        // Decryption failed with encrypt_key configured — likely a
        // spoofing attempt or key mismatch. Reject rather than fall
        // through to plaintext handling.
        return NextResponse.json(
          { error: 'Decryption failed' },
          { status: 401 },
        );
      }
    }

    // verification_token check: Feishu v2 events carry the token in
    // body.header.token. When a verification_token is configured here,
    // any event whose token doesn't match is rejected — this prevents
    // third parties from injecting forged events. url_verification
    // events also carry this token; allow them through so the developer
    // can complete the initial webhook setup in the Feishu console.
    if (feishuCfg?.verification_token) {
      const headerToken = (body as { header?: { token?: string } })?.header
        ?.token;
      const eventType = (body as { header?: { event_type?: string } })?.header
        ?.event_type;
      if (
        headerToken !== feishuCfg.verification_token &&
        eventType !== 'url_verification'
      ) {
        logger.warn('feishu verification_token mismatch', {
          eventType,
        });
        return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
      }
    }

    // URL verification (challenge)
    if (body.challenge) {
      return NextResponse.json({ challenge: body.challenge });
    }

    // Event v2.0 callback
    if (body.header?.event_type === 'im.message.receive_v1') {
      const event = body.event;
      if (event?.message) {
        const { routeAdapterMessage } = await import('@/lib/chat/index');
        // Fire-and-forget: routeAdapterMessage → streamAdapterSourceReply
        // can take longer than the webhook function's maxDuration (the
        // agent may run for minutes). Run it in the background via
        // after() and ack the webhook immediately. This mirrors how the
        // chat-sdk path already behaves (its adapter handleWebhook does
        // not await processMessage, which is registered via waitUntil).
        const payload = {
          adapter: 'feishu' as const,
          origin: event.message.chat_id,
          threadId: event.message.chat_id,
          messageId: event.message.message_id,
          userId: event.sender?.sender_id?.open_id || null,
          userName: event.sender?.sender_id?.open_id || null,
          text: event.message.content || '',
          parts: [],
        };
        after(() =>
          routeAdapterMessage(payload).catch((error) => {
            console.error(
              '[bot/webhook] feishu message processing error:',
              error,
            );
          }),
        );
      }
    }

    // L2 decision button click (feishu card action).
    //
    // notifications/feishu.ts renders L2 prompts as lark cards with
    // buttons whose `value: { action: "l2:<action>:<taskId>:<decisionId>" }`
    // payload is round-tripped here as body.event.action.value.action.
    // We call the same processL2Decision the chat-sdk bot.onAction
    // handler uses, so the bot catch-all path and feishu's webhook
    // share the same code (the bot catch-all only fires for chat-sdk
    // adapters; feishu runs its own webhook handler).
    if (body.header?.event_type === 'card.action.trigger') {
      const actionValue =
        body.event?.action?.value?.action ?? body.event?.action?.value ?? '';
      const actionStr = typeof actionValue === 'string' ? actionValue : '';
      const match =
        /^l2:(pass_once|pass_until|reject_once|reject_until):(.+):(.+)$/.exec(
          actionStr,
        );
      if (match) {
        const [, action, taskId, decisionId] = match;
        const openId = body.event?.operator?.open_id ?? null;
        const chatId = body.event?.action?.chat_id ?? null;
        const { processL2Decision } = await import(
          '@/lib/extra/agent/l2-decision'
        );
        after(() =>
          processL2Decision({
            taskId,
            decisionId,
            action,
            chatId,
            userId: openId,
          }).catch((error) => {
            console.error('[bot/webhook] feishu L2 button error:', error);
          }),
        );
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[bot/webhook] feishu callback error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

async function handleQQWebhook(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json().catch(() => ({}));

    // URL verification
    if (body.op === 13) {
      return NextResponse.json({ echo: body.echo || '' });
    }

    // Message event
    if (body.op === 0) {
      const d = body.d;
      if (d?.content && d?.author) {
        const { routeAdapterMessage } = await import('@/lib/chat/index');
        const isGroup = !!d.group_openid;
        // threadId must be the message-target id (channel id for guild
        // channels, group_openid for group messages) so the
        // QQBotAdapter.postMessage can POST to /channels/{threadId}/messages.
        // Previously this was d.id (the inbound message id), which is not
        // a valid send target.
        const targetId = isGroup
          ? d.group_openid
          : (d.channel_id ?? d.author.id);
        const payload = {
          adapter: 'qq' as const,
          origin: targetId,
          threadId: targetId,
          messageId: d.id,
          userId: d.author.id,
          userName: d.author.username || d.author.id,
          text: d.content || '',
          parts: [],
        };
        after(() =>
          routeAdapterMessage(payload).catch((error) => {
            console.error('[bot/webhook] qq message processing error:', error);
          }),
        );
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[bot/webhook] qq callback error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

/**
 * WeCom smart-bot webhook handler.
 *
 * WeCom smart bots run in Webhook mode (HTTP callback, see lib/bot/wecom-crypto.ts
 * for the AES + SHA1 protocol). Two flows reach this handler:
 *
 * 1. URL verification (GET): WeCom sends msg_signature/timestamp/nonce/echostr,
 *    we verify the signature, decrypt echostr, and return the plaintext echo.
 *    This is handled in the GET function below.
 *
 * 2. Event callback (POST): body is { encrypt: "..." }. After decryption the
 *    plaintext is a JSON event envelope. Two event types matter:
 *      - message (text from the user): forwarded to routeAdapterMessage.
 *      - template_card_event (button click on a card): the button's key
 *        carries the l2:<action>:<taskId>:<decisionId> payload that the
 *        bot.onAction catch-all also matches; we forward it directly to
 *        processL2Decision.
 *
 * Each event callback also carries a response_code for the smart-bot reply
 * API (qyapi.weixin.qq.com/cgi-bin/aibot/response). The WeComBotAdapter
 * (lib/bot/wecom-adapter.ts) posts replies via that code.
 */
async function handleWecomWebhook(request: NextRequest): Promise<NextResponse> {
  try {
    const config = await getConfig();
    const wecomCfg = config.channels?.wecom;
    if (!wecomCfg?.token || !wecomCfg?.encoding_aes_key) {
      // Without webhook-mode credentials we can't decrypt. Reject so the
      // misconfiguration is visible rather than silently dropping events.
      return NextResponse.json(
        { error: 'WeCom webhook credentials not configured' },
        { status: 500 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      encrypt?: string;
      echostr?: string;
    };

    // The encrypt field is the only envelope shape for events. The plain
    // echostr-only body is the GET verification flow, handled separately.
    if (typeof body.encrypt !== 'string') {
      return NextResponse.json(
        { error: 'Missing encrypt field' },
        { status: 400 },
      );
    }

    // Signature verification uses query params msg_signature/timestamp/nonce.
    const url = new URL(request.url);
    const msgSignature = url.searchParams.get('msg_signature') ?? '';
    const timestamp = url.searchParams.get('timestamp') ?? '';
    const nonce = url.searchParams.get('nonce') ?? '';

    if (
      !verifyWecomSignature({
        token: wecomCfg.token,
        timestamp,
        nonce,
        encrypt: body.encrypt,
        msgSignature,
      })
    ) {
      logger.warn('wecom signature verification failed', { timestamp, nonce });
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    const plaintext = decryptWecomPayload({
      encodingAesKey: wecomCfg.encoding_aes_key,
      encrypt: body.encrypt,
    });
    const event = JSON.parse(plaintext) as {
      MsgType?: string;
      Event?: string;
      From?: { UserId?: string };
      Text?: { Content?: string };
      ResponseCode?: string;
      TaskId?: string;
      CardItem?: { Value?: string };
      MsgId?: string;
      ChatId?: string;
    };

    logger.info('wecom event', {
      msgType: event.MsgType,
      event: event.Event,
      from: event.From?.UserId,
    });

    // URL verification events also arrive as POST in some configurations.
    if (event.Event === 'verify_url' || event.MsgType === 'verify_url') {
      return NextResponse.json({ ok: true });
    }

    // Template card button click → L2 decision.
    if (event.Event === 'template_card_event') {
      const actionStr = String(event.CardItem?.Value ?? '');
      const match =
        /^l2:(pass_once|pass_until|reject_once|reject_until):(.+):(.+)$/.exec(
          actionStr,
        );
      if (match) {
        const [, action, taskId, decisionId] = match;
        const { processL2Decision } = await import(
          '@/lib/extra/agent/l2-decision'
        );
        after(() =>
          processL2Decision({
            taskId,
            decisionId,
            action,
            chatId: event.ChatId ?? null,
            userId: event.From?.UserId ?? null,
          }).catch((error) => {
            console.error('[bot/webhook] wecom L2 button error:', error);
          }),
        );
      }
      return NextResponse.json({ ok: true });
    }

    // User text message → route to agent.
    if (event.MsgType === 'text' && event.From?.UserId) {
      const { routeAdapterMessage } = await import('@/lib/chat/index');
      const payload = {
        adapter: 'wecom' as const,
        origin: event.From.UserId,
        // WeCom 1:1 chat has no thread concept beyond the user; use the
        // user id as the thread id so adapter.postMessage targets the
        // same user.
        threadId: event.From.UserId,
        messageId: event.MsgId ?? null,
        userId: event.From.UserId,
        userName: event.From.UserId,
        text: event.Text?.Content ?? '',
        parts: [],
      };
      after(() =>
        routeAdapterMessage(payload).catch((error) => {
          console.error('[bot/webhook] wecom message processing error:', error);
        }),
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[bot/webhook] wecom callback error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ authSecret: string; adapter: string }> },
) {
  const { authSecret, adapter } = await params;

  if (!isValidBotSecret(authSecret)) {
    return NextResponse.json({ error: 'Invalid secret' }, { status: 403 });
  }

  const adapterName = adapter as AdapterName;

  // Chat SDK adapters (Telegram, Discord, Slack, Teams, Google Chat)
  if (CHAT_SDK_ADAPTERS.includes(adapterName)) {
    return handleChatSdkWebhook(adapterName, request);
  }

  // Feishu/Lark — custom SDK adapter
  if (adapterName === 'feishu') {
    return handleFeishuWebhook(request);
  }

  // QQ — custom SDK adapter
  if (adapterName === 'qq') {
    return handleQQWebhook(request);
  }

  // WeCom smart bot — custom webhook with AES decryption
  if (adapterName === 'wecom') {
    return handleWecomWebhook(request);
  }

  return NextResponse.json({ error: 'Unknown adapter' }, { status: 400 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ authSecret: string; adapter: string }> },
) {
  const { authSecret, adapter } = await params;

  if (!isValidBotSecret(authSecret)) {
    return NextResponse.json({ error: 'Invalid secret' }, { status: 403 });
  }

  const adapterName = adapter as AdapterName;

  // Chat SDK adapters — GET is not a valid webhook method, return simple health check
  if (CHAT_SDK_ADAPTERS.includes(adapterName)) {
    return NextResponse.json({ ok: true, adapter: adapterName });
  }

  // Feishu URL verification
  if (adapterName === 'feishu') {
    const url = new URL(request.url);
    const challenge = url.searchParams.get('challenge');
    if (challenge) {
      return NextResponse.json({ challenge });
    }
    return NextResponse.json({ ok: true, adapter: 'feishu' });
  }

  // QQ URL verification
  if (adapterName === 'qq') {
    return NextResponse.json({ ok: true, adapter: 'qq' });
  }

  // WeCom URL verification — msg_signature/timestamp/nonce/echostr query params.
  // Verify signature, decrypt echostr, return plaintext echo.
  if (adapterName === 'wecom') {
    const url = new URL(request.url);
    const msgSignature = url.searchParams.get('msg_signature');
    const timestamp = url.searchParams.get('timestamp');
    const nonce = url.searchParams.get('nonce');
    const echostr = url.searchParams.get('echostr');
    if (!msgSignature || !timestamp || !nonce || !echostr) {
      return NextResponse.json({ ok: true, adapter: 'wecom' }, { status: 200 });
    }
    const config = await getConfig();
    const wecomCfg = config.channels?.wecom;
    if (!wecomCfg?.token || !wecomCfg?.encoding_aes_key) {
      return NextResponse.json(
        { error: 'WeCom webhook credentials not configured' },
        { status: 500 },
      );
    }
    if (
      !verifyWecomSignature({
        token: wecomCfg.token,
        timestamp,
        nonce,
        encrypt: echostr,
        msgSignature,
      })
    ) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
    try {
      const plaintext = decryptWecomPayload({
        encodingAesKey: wecomCfg.encoding_aes_key,
        encrypt: echostr,
      });
      // WeCom expects the plaintext echo as the raw response body.
      return new NextResponse(plaintext, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    } catch (error) {
      console.error('[bot/webhook] wecom echo decrypt failed:', error);
      return NextResponse.json({ error: 'Decrypt failed' }, { status: 500 });
    }
  }

  return NextResponse.json({ error: 'Unknown adapter' }, { status: 400 });
}
