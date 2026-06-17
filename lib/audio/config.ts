import type { AppConfig } from '@/types/config';
import type { AdapterName } from '@/types/config/channels';

/**
 * Resolved TTS settings for a specific request context.
 *
 * Resolution precedence (top wins):
 *   1. Call-site override (e.g. user-selected voice for this message)
 *   2. Per-channel voice (config.channels[adapter].tts_voice)
 *      — only when source.adapter is set
 *   3. Global defaults (config.tts) — voice is a bot-wide personality
 *      attribute, like locale
 *
 * `enabled` reflects whether voice output should be produced for this
 * request. It is NOT read from a global master switch (we removed that)
 * — it is decided entirely by the call site:
 *   - IM source:  config.channels[adapter].tts_enabled === true
 *   - Web source: callers gate on their own per-user toggle before
 *                 even calling synthesizeSpeech; resolver returns the
 *                 user-controlled flag as-is via `webEnabled` input
 *   - Scheduled:  never TTS
 */
export interface ResolvedTtsSettings {
  enabled: boolean;
  voice: string;
  model?: string;
  format: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
}

const DEFAULT_VOICE = 'alloy';
const DEFAULT_FORMAT = 'mp3' as const;

export function resolveTtsSettings(input: {
  config: AppConfig;
  source?:
    | { type: 'im'; adapter: AdapterName }
    | { type: 'web' }
    | { type: 'scheduled' };
  /** For Web requests, the caller passes its own per-user toggle. Ignored for non-web sources. */
  webEnabled?: boolean;
  voiceOverride?: string;
  modelOverride?: string;
  formatOverride?: ResolvedTtsSettings['format'];
}): ResolvedTtsSettings {
  const globalTts = input.config.tts;
  const source = input.source;

  let perChannelEnabled = false;
  let perChannelVoice: string | undefined;

  if (source && source.type === 'im') {
    const adapterCfg = input.config.channels?.[source.adapter];
    perChannelEnabled = adapterCfg?.tts_enabled === true;
    perChannelVoice = adapterCfg?.tts_voice;
  }

  const webEnabled = source?.type === 'web' ? input.webEnabled === true : false;

  const enabled = perChannelEnabled || webEnabled;

  return {
    enabled,
    voice:
      input.voiceOverride ??
      perChannelVoice ??
      globalTts?.voice ??
      DEFAULT_VOICE,
    model: input.modelOverride ?? globalTts?.model,
    format: input.formatOverride ?? globalTts?.format ?? DEFAULT_FORMAT,
  };
}
