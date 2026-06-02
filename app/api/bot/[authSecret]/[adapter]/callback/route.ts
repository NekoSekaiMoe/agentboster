import { createExtraAdapters } from '@/lib/bot/adaptor';
import { getBot } from '@/lib/bot/index';
import { isValidBotSecret } from '@/lib/bot/webhook';
import { getConfig } from '@/lib/core/kv/config';
import type { AdapterName } from '@/types/config/channels';
import { after } from 'next/server';
import { NextRequest, NextResponse } from 'next/server';

const CHAT_SDK_ADAPTERS = ['slack', 'teams', 'gchat', 'telegram', 'discord'];

async function handleChatSdkWebhook(
  adapterName: AdapterName,
  request: NextRequest,
): Promise<Response> {
  try {
    const bot = await getBot();
    const adapterInstance = bot.getAdapter(adapterName);

    if (!adapterInstance) {
      return NextResponse.json(
        { error: `Adapter ${adapterName} not configured or enabled` },
        { status: 404 },
      );
    }

    const result = await adapterInstance.handleWebhook?.(request, {
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
    const config = await getConfig();
    const extra = createExtraAdapters(config.channels);
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
        await routeAdapterMessage({
          adapter: 'feishu',
          origin: event.message.chat_id,
          threadId: event.message.message_id,
          userId: event.sender?.sender_id?.open_id || null,
          userName: event.sender?.sender_id?.open_id || null,
          text: event.message.content || '',
          parts: [],
        });
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
        await routeAdapterMessage({
          adapter: 'qq',
          origin: isGroup ? d.group_openid : d.author.id,
          threadId: d.id,
          userId: d.author.id,
          userName: d.author.username || d.author.id,
          text: d.content || '',
          parts: [],
        });
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

  // Chat SDK adapters — delegate to adapter
  if (CHAT_SDK_ADAPTERS.includes(adapterName)) {
    return handleChatSdkWebhook(adapterName, request);
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
