import { guardWorkflowChunks } from '@/lib/chat/stream-guard';
import { getBaseBot } from '@/lib/bot/core';
import { getBotCapabilities } from '@/lib/bot/capabilities';
import { getConfig } from '@/lib/core/kv/config';
import { postAdapterVoiceReply } from '@/lib/bot/voice';
import { createLogger } from '@/lib/utils/logger';
import { getRun } from 'workflow/api';
import type { ChatSource } from '@/types/workflow';
import type { AdapterName } from '@/types/config/channels';
import type { BotLocale } from '@/types/config/language';

const logger = createLogger('api.im_stream');

/**
 * IM stream consumer endpoint.
 *
 * Why this exists: IM webhooks must return a fast 200 ACK (IM platforms
 * retry otherwise), so they cannot host the stream consumer themselves.
 * The workflow runtime cannot host it either — setInterval/setTimeout
 * are forbidden there (determinism), and experimental_transform is a
 * function the runtime cannot serialize. This endpoint is the third
 * place: a plain Node.js function whose HTTP Response body is itself a
 * ReadableStream. A streaming Response keeps the function alive past
 * maxDuration on Vercel (the same trick the web chat route uses in
 * app/(chat)/api/ai/route.ts), so we can drain the whole workflow
 * readable and edit the IM message on a throttled cadence — giving IM
 * users the same progressive typing the web UI has always had.
 *
 * Trigger: webhook handler calls this endpoint fire-and-forget (void
 * fetch, no await) right after startWorkflow returns. The fetch carries
 * the runId + a serialized IM source so this function can address the
 * target chat thread and pick the right adapter.
 *
 * Body: a do-nothing ReadableStream that stays open for the duration of
 * the workflow run. Nobody reads the response — its sole purpose is to
 * keep the function's HTTP response (and therefore the function) from
 * completing. When the workflow stream closes, we close our dummy
 * stream, Vercel flushes the empty body, and the function exits cleanly.
 */

const TYPING_REFRESH_MS = 4500;
const EDIT_MIN_DELTA_CHARS = 20;
const EDIT_MAX_INTERVAL_MS = 500;

interface ImStreamQuery {
  runId: string;
  adapter: AdapterName;
  threadId: string;
  userId?: string;
  locale?: string;
}

function parseQuery(url: URL): ImStreamQuery | null {
  const runId = url.searchParams.get('runId');
  const adapter = url.searchParams.get('adapter') as AdapterName | null;
  const threadId = url.searchParams.get('threadId');
  if (!runId || !adapter || !threadId) return null;
  return {
    runId,
    adapter,
    threadId,
    userId: url.searchParams.get('userId') || undefined,
    locale: url.searchParams.get('locale') || undefined,
  };
}

function asBotLocale(value: string | undefined): BotLocale | undefined {
  if (!value) return undefined;
  const locales: readonly BotLocale[] = [
    'auto',
    'en-US',
    'en-GB',
    'zh-CN',
    'zh-TW',
    'zh-HK',
    'ja',
    'ko',
  ];
  return (locales as readonly string[]).includes(value)
    ? (value as BotLocale)
    : undefined;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const q = parseQuery(url);
  if (!q) {
    return new Response('Missing runId/adapter/threadId', { status: 400 });
  }

  const source: Extract<ChatSource, { type: 'im' }> = {
    type: 'im',
    adapter: q.adapter,
    // origin is required by IMChatSource but only used for chat-sdk
    // thread-id round-tripping in the inbound direction; the outbound
    // path (postMessage/editMessage) keys everything off threadId.
    origin: q.threadId,
    threadId: q.threadId,
    userId: q.userId ?? null,
    locale: asBotLocale(q.locale),
  };

  // Resolve adapter + capabilities up front so we can fail fast and so
  // the loop doesn't pay the init cost on every edit.
  const config = await getConfig();
  const channelCfg = config.channels?.[q.adapter];
  const ttsEnabled = channelCfg?.tts_enabled === true;
  const canEdit = getBotCapabilities(q.adapter).edit;

  let bot: Awaited<ReturnType<typeof getBaseBot>>;
  try {
    bot = await getBaseBot();
  } catch (error) {
    logger.warn('init_failed', {
      adapter: q.adapter,
      runId: q.runId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Nothing else we can do — bail with an empty stream so the fetch
    // resolves and the webhook isn't left hanging on a non-response.
    return new Response(
      new ReadableStream({
        start(c) {
          c.close();
        },
      }),
    );
  }
  const adapter = bot.getAdapter(q.adapter);

  // Stream body: stays open until the workflow readable closes. This is
  // what keeps the function alive past maxDuration.
  const keepAlive = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await drainStream({
          runId: q.runId,
          source,
          adapter,
          canEdit,
          ttsEnabled,
          ttsSource: source,
        });
      } catch (error) {
        logger.warn('drain_failed', {
          runId: q.runId,
          adapter: q.adapter,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(keepAlive, {
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

interface DrainArgs {
  runId: string;
  source: Extract<ChatSource, { type: 'im' }>;
  adapter: ReturnType<Awaited<ReturnType<typeof getBaseBot>>['getAdapter']>;
  canEdit: boolean;
  ttsEnabled: boolean;
  ttsSource: Extract<ChatSource, { type: 'im' }>;
}

async function drainStream(args: DrainArgs): Promise<void> {
  const { runId, source, adapter, canEdit, ttsEnabled, ttsSource } = args;

  // TTS path: synthesize one voice clip from the complete text. Skip
  // mid-run edits entirely — IM users on tts_enabled channels get a
  // single voice message at the end, same as before.
  if (ttsEnabled) {
    const fullText = await drainToText(runId);
    if (fullText.trim()) {
      try {
        await postAdapterVoiceReply(ttsSource, fullText);
      } catch (error) {
        logger.warn('tts_failed', {
          runId,
          adapter: source.adapter,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return;
  }

  // Non-TTS path: progressive post + editMessage.
  const workflowReadable = guardWorkflowChunks(getRun(runId).readable);
  const reader = workflowReadable.getReader();

  let messageId: string | null = null;
  let fullText = '';
  let lastEditedText = '';
  let lastEditAt = 0;
  const emittedToolCallIds = new Set<string>();
  let typingTimer: ReturnType<typeof setInterval> | null = null;

  const refreshTyping = () => {
    void adapter.startTyping(source.threadId).catch(() => {
      // best-effort: unsupported adapters / rate limits
    });
  };
  refreshTyping();
  typingTimer = setInterval(refreshTyping, TYPING_REFRESH_MS);

  const tryEdit = async (force: boolean) => {
    if (!messageId) return;
    if (fullText === lastEditedText) return;
    if (!force) {
      const lenDelta = fullText.length - lastEditedText.length;
      const timeDelta = Date.now() - lastEditAt;
      if (lenDelta < EDIT_MIN_DELTA_CHARS && timeDelta < EDIT_MAX_INTERVAL_MS) {
        return;
      }
    }
    try {
      await adapter.editMessage(source.threadId, messageId, {
        markdown: fullText,
      });
      lastEditedText = fullText;
      lastEditAt = Date.now();
    } catch (error) {
      logger.warn('edit_failed', {
        runId,
        adapter: source.adapter,
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  try {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (!chunk || typeof chunk !== 'object') continue;

      const c = chunk as Record<string, unknown>;
      const type = c.type;

      if (type === 'text-delta') {
        const delta =
          typeof c.delta === 'string'
            ? c.delta
            : typeof c.text === 'string'
              ? c.text
              : '';
        if (delta) {
          fullText += delta;
          if (!messageId) {
            // First text → post the initial message immediately.
            try {
              const posted = await adapter.postMessage(source.threadId, {
                markdown: fullText,
              });
              messageId = posted.id;
              lastEditedText = fullText;
              lastEditAt = Date.now();
            } catch (error) {
              logger.warn('post_failed', {
                runId,
                adapter: source.adapter,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          } else {
            // Throttled edits; the helper checks delta + interval.
            void tryEdit(false);
          }
        }
      } else if (type === 'tool-input-available' || type === 'tool-call') {
        const tcId = typeof c.toolCallId === 'string' ? c.toolCallId : '';
        const toolName = typeof c.toolName === 'string' ? c.toolName : '';
        if (tcId && !emittedToolCallIds.has(tcId)) {
          emittedToolCallIds.add(tcId);
          const label = toolName
            ? toolName
                .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
                .split(/[_\s-]+/)
                .filter(Boolean)
                .map((s) => s[0].toUpperCase() + s.slice(1))
                .join(' ')
            : 'tool';
          fullText += `\n\n🔧 ${label}...\n\n`;
          if (messageId) void tryEdit(false);
        }
      }
    }
  } finally {
    reader.releaseLock();
    if (typingTimer) clearInterval(typingTimer);
  }

  // Final flush: ensure the complete text is reflected.
  if (messageId && fullText && fullText !== lastEditedText) {
    await tryEdit(true);
  }

  // Non-edit adapters (feishu/qq) never editMessage'd — they only have
  // the initial post. Post the full text as a final message so users
  // see the complete reply even though edits were no-ops.
  if (!canEdit && !messageId && fullText.trim()) {
    try {
      await adapter.postMessage(source.threadId, { markdown: fullText });
    } catch (error) {
      logger.warn('final_post_failed', {
        runId,
        adapter: source.adapter,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Drain the workflow readable into plain text. Used for the TTS path. */
async function drainToText(runId: string): Promise<string> {
  const readable = guardWorkflowChunks(getRun(runId).readable);
  const reader = readable.getReader();
  let fullText = '';
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (!chunk || typeof chunk !== 'object') continue;
      const c = chunk as Record<string, unknown>;
      if (c.type === 'text-delta') {
        const delta =
          typeof c.delta === 'string'
            ? c.delta
            : typeof c.text === 'string'
              ? c.text
              : '';
        if (delta) fullText += delta;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return fullText;
}
