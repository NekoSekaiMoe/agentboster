import type { AppConfig } from '@/types/config';
import type { AdapterName } from '@/types/config/channels';

/**
 * Resolved TTS settings for a specific request context.
 *
 * Resolution precedence (top wins):
 *   1. Call-site override (e.g. user-selected voice for this message)
 *   2. Per-channel settings (config.channels[adapter].tts_enabled / tts_voice)
 *      — only when source.adapter is set
 *   3. Global defaults (config.tts)
 *
 * `enabled` reflects whether voice output should be produced AT ALL for
 * this request. The Web client additionally honors a per-session
 * localStorage toggle (chat.tts_autoplay seeds its default).
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

  // Web requests use the global enabled flag; scheduled broadcasts never TTS.
  const webEnabled =
    source?.type === 'web' ? globalTts?.enabled === true : false;

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
