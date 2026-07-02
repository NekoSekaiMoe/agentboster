import { getBot } from '@/lib/bot/index';
import { isValidBotSecret } from '@/lib/bot/webhook';
import type { AdapterName } from '@/types/config/channels';
import { after } from 'next/server';
import { NextRequest, NextResponse } from 'next/server';

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

async function handleFeishuWebhook(
  request: NextRequest,
): Promise<NextResponse> {
  try {
    const body = await request.json().catch(() => ({}));

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
          threadId: event.message.message_id,
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
          '@/app/api/agentd/v1/l2-confirm/route'
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
        // Fire-and-forget — see the feishu branch above for rationale.
        const payload = {
          adapter: 'qq' as const,
          origin: isGroup ? d.group_openid : d.author.id,
          threadId: d.id,
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

  return NextResponse.json({ error: 'Unknown adapter' }, { status: 400 });
}
