import { NextRequest, NextResponse } from 'next/server';
import { isValidBotSecret } from '@/lib/bot/webhook';
import { getBot } from '@/lib/bot/index';
import type { AdapterName } from '@/types/config/channels';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ authSecret: string; adapter: string }> },
) {
  const { authSecret, adapter } = await params;

  if (!isValidBotSecret(authSecret)) {
    return NextResponse.json({ error: 'Invalid secret' }, { status: 403 });
  }

  const adapterName = adapter as AdapterName;
  const validAdapters = ['slack', 'teams', 'gchat', 'telegram'];
  if (!validAdapters.includes(adapterName)) {
    return NextResponse.json({ error: 'Unknown adapter' }, { status: 400 });
  }

  try {
    const bot = await getBot();
    const adapterInstance = bot.getAdapter(adapterName);

    if (!adapterInstance) {
      return NextResponse.json(
        { error: `Adapter ${adapterName} not configured or enabled` },
        { status: 404 },
      );
    }

    // Delegate to the Chat SDK adapter's webhook handler
    const body = await request.text();
    const headers = Object.fromEntries(request.headers.entries());

    const result = await adapterInstance.handleWebhook?.({
      body,
      headers,
      method: request.method,
    });

    return NextResponse.json(result ?? { ok: true });
  } catch (error) {
    console.error(`[bot/webhook] ${adapterName} callback error:`, error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
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

  // Some adapters (e.g. Telegram) use GET for webhook verification
  try {
    const bot = await getBot();
    const adapterInstance = bot.getAdapter(adapterName);

    if (!adapterInstance) {
      return NextResponse.json(
        { error: `Adapter ${adapterName} not configured or enabled` },
        { status: 404 },
      );
    }

    // Pass query params for verification challenges
    const url = new URL(request.url);
    const challenge = url.searchParams.get('challenge');

    if (challenge && adapterInstance.handleWebhook) {
      const result = await adapterInstance.handleWebhook({
        body: JSON.stringify({ challenge }),
        headers: {},
        method: 'GET',
      });
      return NextResponse.json(result ?? { ok: true });
    }

    return NextResponse.json({ ok: true, adapter: adapterName });
  } catch (error) {
    console.error(`[bot/webhook] ${adapterName} GET error:`, error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
