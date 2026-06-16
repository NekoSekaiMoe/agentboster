import { experimental_generateSpeech as generateSpeech, type SpeechModel } from 'ai';

import { resolveSpeechModel } from '@/lib/audio/speech';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';

const logger = createLogger('audio.generate');

/**
 * Synthesize speech audio bytes for the given text.
 *
 * Wraps the AI SDK's generateSpeech with this project's config resolution
 * (AppConfig.tts + per-channel voice override). Returns the raw audio
 * bytes and the resolved mime type so callers can either stream them to
 * the Web client or attach them to an IM message.
 *
 * Provider restriction: only OpenAI is supported today (see
 * lib/ai/providers.ts getSpeechModel). The resolver throws for any
 * other provider format, so callers should catch and fall back to text.
 */
export async function synthesizeSpeech(input: {
  text: string;
  config: AppConfig;
  voice?: string;
  model?: string;
  format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
}): Promise<{ audio: Uint8Array; mimeType: string; format: string }> {
  const modelId = input.model ?? input.config.tts?.model;
  if (!modelId) {
    throw new Error(
      'TTS model is not configured. Set tts.model in the config (must route to an OpenAI provider).',
    );
  }

  const text = input.text?.trim();
  if (!text) {
    throw new Error('TTS text is empty.');
  }

  const format = input.format ?? input.config.tts?.format ?? 'mp3';
  const voice = input.voice ?? input.config.tts?.voice ?? 'alloy';
  const model = resolveSpeechModel(modelId, input.config);

  const result = await runGenerateSpeech({
    model,
    text,
    voice,
    outputFormat: format,
  });

  const audio = result.audio?.uint8Array;
  if (!audio || audio.byteLength === 0) {
    throw new Error('TTS returned no audio data.');
  }

  const mimeType = mimeTypeForFormat(format);
  logger.info('synthesize:done', {
    modelId,
    voice,
    format,
    bytes: audio.byteLength,
  });

  return { audio, mimeType, format };
}

// Thin wrapper around generateSpeech to keep this module unit-testable
// without depending on the live network call.
async function runGenerateSpeech(args: {
  model: SpeechModel;
  text: string;
  voice: string;
  outputFormat: string;
}) {
  return generateSpeech({
    model: args.model,
    text: args.text,
    voice: args.voice,
    outputFormat: args.outputFormat as
      | 'mp3'
      | 'wav'
      | (string & {})
      | undefined,
  });
}

export function mimeTypeForFormat(
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
