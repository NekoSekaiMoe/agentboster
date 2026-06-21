export const dynamic = 'force-dynamic';

import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.agentd.llm-proxy');

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { model, messages, stream } = body;

    // Get AI provider config from app config
    const providerUrl =
      process.env.AI_PROVIDER_URL ?? process.env.OPENAI_API_URL;
    const providerKey =
      process.env.AI_PROVIDER_KEY ?? process.env.OPENAI_API_KEY;

    if (!providerUrl || !providerKey) {
      return Response.json(
        { success: false, error: 'AI provider not configured' },
        { status: 500 },
      );
    }

    const response = await fetch(providerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${providerKey}`,
      },
      body: JSON.stringify({
        model: model ?? process.env.AI_MODEL ?? 'gpt-4o-mini',
        messages,
        stream: stream ?? false,
        temperature: 0.1,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('LLM proxy error', {
        status: response.status,
        error: errorText,
      });
      return Response.json(
        { success: false, error: `LLM error: ${response.status}` },
        { status: response.status },
      );
    }

    if (stream) {
      return new Response(response.body, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    const data = await response.json();
    return Response.json({ success: true, data });
  } catch (error) {
    logger.error('LLM proxy failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'LLM proxy failed' },
      { status: 500 },
    );
  }
}
