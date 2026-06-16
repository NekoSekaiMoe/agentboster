import { synthesizeSpeech } from '@/lib/audio/generate';
import { getCachedSpeech, setCachedSpeech } from '@/lib/audio/cache';
import { getConfig } from '@/lib/core/kv/config';
import { readAuthSessionFromCookies } from '@/lib/auth';
import { createLogger } from '@/lib/utils/logger';
import { z } from 'zod';
import { cookies } from 'next/headers';

const logger = createLogger('api.tts');

const requestSchema = z.object({
  text: z.string().min(1).max(4096),
  voice: z.string().optional(),
  model: z.string().optional(),
  format: z
    .enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'])
    .optional(),
});

/**
 * Synthesize speech for a chunk of assistant text. Used by the Web
 * client's auto-play (latest assistant message) and per-message play
 * buttons. Audio is cached by (model, voice, format, text) so repeat
 * plays are free.
 *
 * Returns audio bytes with the appropriate Content-Type. On any failure
 * returns 500 with a JSON error — the client falls back to silence.
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const authSession = await readAuthSessionFromCookies(cookieStore);
  if (!authSession) {
    return Response.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 },
    );
  }

  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await request.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        { success: false, error: 'Invalid request', details: error.issues },
        { status: 400 },
      );
    }
    return Response.json(
      { success: false, error: 'Invalid JSON' },
      { status: 400 },
    );
  }

  const config = await getConfig();
  if (!config.tts?.enabled) {
    return Response.json(
      {
        success: false,
        error:
          'TTS is disabled. Enable it in Config > Text-to-Speech (requires an OpenAI provider).',
      },
      { status: 403 },
    );
  }

  const voice = body.voice ?? config.tts.voice ?? 'alloy';
  const format = body.format ?? config.tts.format ?? 'mp3';
  const model = body.model ?? config.tts.model;

  // Cache lookup
  const cacheKey = { text: body.text, voice, model, format };
  const cached = await getCachedSpeech(cacheKey);
  if (cached) {
    logger.info('cache_hit', { bytes: cached.byteLength });
    return new Response(Buffer.from(cached), {
      headers: {
        'content-type': mimeTypeForFormat(format),
        'cache-control': 'public, max-age=604800',
        'x-tts-cache': 'HIT',
      },
    });
  }

  try {
    const { audio, mimeType } = await synthesizeSpeech({
      text: body.text,
      config,
      voice,
      model,
      format,
    });
    // Best-effort cache write.
    await setCachedSpeech(cacheKey, audio);
    return new Response(Buffer.from(audio), {
      headers: {
        'content-type': mimeType,
        'cache-control': 'public, max-age=604800',
        'x-tts-cache': 'MISS',
      },
    });
  } catch (error) {
    logger.error('synthesize_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : 'TTS synthesis failed',
      },
      { status: 500 },
    );
  }
}

function mimeTypeForFormat(
  format: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm',
): string {
  switch (format) {
    case 'mp3':
      return 'audio/mpeg';
    case 'opus':
      return 'audio/ogg';
    case 'aac':
      return 'audio/aac';
    case 'flac':
      return 'audio/flac';
    case 'wav':
      return 'audio/wav';
    case 'pcm':
      return 'audio/pcm';
    default:
      return 'audio/mpeg';
  }
}
