import { z } from 'zod';

import { aiModelConfigSchema } from './ai';

/**
 * Global Text-to-Speech configuration.
 *
 * This section holds bot-wide defaults that behave like personality
 * attributes (analogous to bot.locale): a single voice / model / format
 * the bot speaks in, regardless of which channel asks it to.
 *
 * Whether TTS is actually produced for a given request is decided at
 * the call site, NOT here:
 *   - Web:    per-user localStorage toggle 'chat:tts_autoplay'
 *   - IM:     per-channel 'channels[x].tts_enabled' flag
 *
 * Provider restriction: only the OpenAI provider's `speech(model)` API
 * is supported (see lib/ai/providers.ts getSpeechModel). Selecting any
 * other provider for the speech model throws at resolve time.
 */
export const ttsConfigSchema = z.object({
  /** Speech model ID (e.g. "openai/tts-1", "openai/gpt-4o-mini-tts"). Must route to an OpenAI provider. */
  model: aiModelConfigSchema.optional(),
  /** Voice name — the bot's speaking voice, treated as a personality attribute like locale. OpenAI choices include "alloy", "echo", "fable", "onyx", "nova", "shimmer", plus newer voices on gpt-4o-mini-tts. */
  voice: z.string().optional(),
  /** Output audio container/format. OpenAI supports "mp3", "opus", "aac", "flac", "wav", "pcm". */
  format: z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']).default('mp3'),
});

export type TtsConfig = z.infer<typeof ttsConfigSchema>;
