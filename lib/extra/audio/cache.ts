import { createHash } from 'node:crypto';

import { get, set } from '@/lib/core/kv';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('audio.cache');

const KEY_PREFIX = 'tts:v1:';
// 7 days. TTS audio is small but generates quickly enough that we don't
// want stale voice/model changes to be served indefinitely.
const TTL_SECONDS = 60 * 60 * 24 * 7;

/**
 * Best-effort cache for synthesized speech audio. The same text + voice +
 * model + format combo should always produce the same audio, so we cache
 * the base64-encoded result in KV to avoid paying the OpenAI TTS bill
 * twice for repeat plays.
 *
 * Returns null on cache miss or any KV error (caller falls back to a
 * live generateSpeech call).
 */
export async function getCachedSpeech(input: {
  text: string;
  voice: string;
  model?: string;
  format: string;
}): Promise<Uint8Array | null> {
  const key = cacheKey(input);
  try {
    const raw = await get(key);
    if (typeof raw !== 'string' || raw.length === 0) {
      return null;
    }
    const bytes = Buffer.from(raw, 'base64');
    return new Uint8Array(bytes);
  } catch (error) {
    logger.warn('cache:get_failed', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Store synthesized audio in KV. Failures are logged and swallowed — a
 * cache write error should never break TTS playback.
 */
export async function setCachedSpeech(
  input: { text: string; voice: string; model?: string; format: string },
  audio: Uint8Array,
): Promise<void> {
  const key = cacheKey(input);
  try {
    const base64 = Buffer.from(audio).toString('base64');
    await set(key, base64, { ex: TTL_SECONDS });
  } catch (error) {
    logger.warn('cache:set_failed', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function cacheKey(input: {
  text: string;
  voice: string;
  model?: string;
  format: string;
}): string {
  const payload = `${input.model ?? ''}|${input.voice}|${input.format}|${input.text}`;
  const hash = createHash('sha256').update(payload).digest('hex').slice(0, 32);
  return `${KEY_PREFIX}${hash}`;
}
