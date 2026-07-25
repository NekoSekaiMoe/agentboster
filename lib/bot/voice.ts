import { synthesizeSpeech } from '@/lib/extra/audio/generate';
import { resolveTtsSettings } from '@/lib/extra/audio/config';
import { getConfig } from '@/lib/core/kv/config';
import { createLogger } from '@/lib/utils/logger';
import type { ChatSource } from '@/types/workflow';
import type { AdapterName } from '@/types/config/channels';

import { getBaseBot } from './core';
import { postAdapterReply } from './reply';

const logger = createLogger('bot.voice');

/**
 * Send the assistant reply to an IM channel as a voice/audio message
 * instead of plain text. Backed by synthesizeSpeech (OpenAI TTS) and
 * the chat SDK's files: FileUpload[] postMessage shape, which the
 * underlying platform adapter uploads natively.
 *
 * Behavior matrix (per-adapter):
 *   - Discord / Slack / Teams: chat SDK uploads as audio attachment.
 *     Native inline playback.
 *   - Telegram: sendAudio via chat SDK. (Not sendVoice — that would
 *     require OPUS + raw fetch; we ship mp3 and accept the generic
 *     audio attachment UI.)
 *   - Feishu / GChat / QQ: audio upload unsupported by the adapter;
 *     we fall back to the normal markdown text reply.
 *
 * On any TTS failure (synthesis error, no model configured, network),
 * we fall back to the text reply path so the user still gets the answer.
 */
export async function postAdapterVoiceReply(
  source: Extract<ChatSource, { type: 'im' }>,
  text: string,
): Promise<boolean> {
  const config = await getConfig();
  const tts = resolveTtsSettings({ config, source });

  if (!tts.enabled) {
    return postAdapterTextFallback(source, text);
  }

  if (!tts.model) {
    logger.warn('voice:no_model', { adapter: source.adapter });
    return postAdapterTextFallback(source, text);
  }

  // Adapters that lack a usable audio upload path. For these we don't
  // even attempt synthesis — straight to text.
  if (!adapterSupportsAudioUpload(source.adapter)) {
    logger.info('voice:adapter_text_fallback', {
      adapter: source.adapter,
    });
    return postAdapterTextFallback(source, text);
  }

  let audio: Uint8Array;
  let mimeType: string;
  try {
    const out = await synthesizeSpeech({
      text,
      config,
      voice: tts.voice,
      model: tts.model,
      format: tts.format,
    });
    audio = out.audio;
    mimeType = out.mimeType;
  } catch (error) {
    logger.warn('voice:synthesize_failed', {
      adapter: source.adapter,
      error: error instanceof Error ? error.message : String(error),
    });
    return postAdapterTextFallback(source, text);
  }

  try {
    const bot = await getBaseBot();
    const adapter = bot.getAdapter(source.adapter);
    const filename = filenameForFormat(tts.format);
    await adapter.postMessage(source.threadId, {
      markdown: text,
      files: [
        {
          data: Buffer.from(audio),
          filename,
          mimeType,
        },
      ],
    });
    logger.info('voice:sent', {
      adapter: source.adapter,
      threadId: source.threadId,
      bytes: audio.byteLength,
      format: tts.format,
    });
    return true;
  } catch (error) {
    logger.warn('voice:send_failed', {
      adapter: source.adapter,
      error: error instanceof Error ? error.message : String(error),
    });
    return postAdapterTextFallback(source, text);
  }
}

/**
 * Whether the chat SDK adapter for this platform can upload an audio
 * attachment via postMessage's files: FileUpload[] shape. Conservative
 * allow-list — when in doubt, fall back to text rather than attempting
 * and failing.
 */
function adapterSupportsAudioUpload(adapter: AdapterName): boolean {
  // The chat SDK adapters for these platforms implement file upload
  // (multipart for Discord, files.uploadV2 for Slack, Graph
  // fileAttachments for Teams, sendAudio for Telegram). Feishu, GChat,
  // and QQ either lack adapter-level audio upload or require custom
  // raw-fetch paths we don't ship in this iteration.
  switch (adapter) {
    case 'telegram':
    case 'discord':
    case 'slack':
    case 'teams':
      return true;
    case 'gchat':
    case 'feishu':
    case 'qq':
      return false;
    default:
      return false;
  }
}

function filenameForFormat(
  format: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm',
): string {
  return `reply.${format}`;
}

async function postAdapterTextFallback(
  source: Extract<ChatSource, { type: 'im' }>,
  text: string,
): Promise<boolean> {
  try {
    const bot = await getBaseBot();
    const adapter = bot.getAdapter(source.adapter);
    await postAdapterReply({ adapter, source, text });
    return true;
  } catch (error) {
    logger.error('voice:fallback_failed', {
      adapter: source.adapter,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
