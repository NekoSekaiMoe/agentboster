import { z } from 'zod';

import { aiModelConfigSchema } from './ai';

/**
 * Global Text-to-Speech configuration.
 *
 * Applied as the default for the Web client (toggle opt-in per session)
 * and as the fallback for IM channels that have tts_enabled=true but no
 * per-channel voice override.
 *
 * Provider restriction: only the OpenAI provider's `speech(model)` API
 * is supported (see lib/ai/providers.ts getSpeechModel). Selecting any
 * other provider for the speech model throws at resolve time.
 */
export const ttsConfigSchema = z.object({
  /** Master switch for Web auto-play. The Web client additionally honors a per-session localStorage toggle. */
  enabled: z.boolean().default(false),
  /** Speech model ID (e.g. "openai/tts-1", "openai/gpt-4o-mini-tts"). Must route to an OpenAI provider. */
  model: aiModelConfigSchema.optional(),
  /** Voice name. OpenAI choices include "alloy", "echo", "fable", "onyx", "nova", "shimmer", plus newer voices on gpt-4o-mini-tts. */
  voice: z.string().optional(),
  /** Output audio container/format. OpenAI supports "mp3", "opus", "aac", "flac", "wav", "pcm". */
  format: z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']).default('mp3'),
});

export type TtsConfig = z.infer<typeof ttsConfigSchema>;
