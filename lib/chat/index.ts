import { sendAdapterSourceReply } from '@/lib/bot/reply';
import {
  assertSessionWritable,
  currentChannelName,
  evaluateSessionAccess,
} from '@/lib/chat/access';
import {
  createSession,
  deleteMessagesAfterUiMessageId,
  getFirstVisibleSessionMessage,
  getMessageByUiMessageId,
  getSession,
  getSessionByExternalThreadId,
  listSessions,
  listSessionsByExternalThreadIds,
  updateSession,
  upsertUserMessage,
} from '@/lib/core/db/chat';
import { resolveClawLessUserId } from '@/lib/core/db/im-accounts';
import { getUserById } from '@/lib/core/db/users';
import { getConfig } from '@/lib/core/kv/config';
import { getSessionRuntime } from '@/lib/core/sandbox/session-runtime';
import { invalidateCurrentSessionSummary } from '@/lib/memory';
import { generateUUID } from '@/lib/utils';
import { createLogger } from '@/lib/utils/logger';
import { buildInitialContextMessages } from '@/lib/workflow/agent/context';
import {
  canResumeRun,
  pauseWorkflow,
  requestCompact,
  resumeToolApproval,
  resumeWithMessage,
  startWorkflow,
} from '@/lib/workflow/agent/dispatch';
import type { ClientSpoof } from '@/types/config/ai';
import type { AdapterName } from '@/types/config/channels';
import type { BotLocale } from '@/types/config/language';
import {
  type ChatInputEnvelope,
  type ChatMessageMetadata,
  type ChatSource,
  COMMANDS,
  type Command,
  type WorkflowUIMessage,
  type WorkflowUIMessageChunk,
  buildExternalThreadId,
  normalizeMessageText,
  parseChatInputEnvelope,
} from '@/types/workflow';
import { normalizeUserMessageParts } from './attachment-processing';
import { executeCancelCommand } from './commands/cancel';
import { executeConfigCommand } from './commands/config';
import { executeIdCommand } from './commands/id';
import { executeLangCommand } from './commands/lang';
import { executeMemoryCommand } from './commands/memory';
import { executeModelCommand } from './commands/model';
import { executePairCommand, executeUnpairCommand } from './commands/pair';
import { executeProviderCommand } from './commands/provider';
import { executeResetCommand } from './commands/reset';
import { executeRetryCommand } from './commands/retry';
import { executeStartCommand } from './commands/start';
import { executeVersionCommand } from './commands/version';
import { executeWhoamiCommand } from './commands/whoami';
import {
  executeAttachCommand,
  executeDetachCommand,
  executeRemoteCommand,
} from './commands/remote';
import {
  checkDuplicate,
  checkIdempotencyDuplicate,
  recordIdempotencyMessage,
  recordMessage,
} from './dedup';
import { INIT_AGENTS_MD_MARKER, INIT_AGENTS_MD_PROMPT } from './init-prompt';
import { serializeUserMessage } from './message-utils';
import { cleanupChatSession } from './session-cleanup';
import { deriveSessionTitle } from './session-title';
import { t } from '@/lib/i18n/server';
import type { Locale } from '@/lib/i18n';

const chatMainLogger = createLogger('chat.main');

type Trigger = 'submit-message' | 'regenerate-message' | 'route-message';

export type DispatchChatInputResult =
  | {
      kind: 'message';
      result: {
        sessionId: string;
        runId: string;
        readable: ReadableStream<WorkflowUIMessageChunk>;
      };
    }
  | {
      kind: 'resume-run-message';
      result: {
        sessionId: string;
        runId: string;
      };
    }
  | {
      kind: 'command';
      result: {
        sessionId: string;
        text: string;
        readable?: ReadableStream<WorkflowUIMessageChunk>;
        runId?: string | null;
      };
    };

type LegacyChatMainRequest = {
  trigger: Trigger;
  input: {
    parts?: ChatInputEnvelope['parts'];
    text?: string;
    metadata?: ChatMessageMetadata;
  };
  messages?: WorkflowUIMessage[];
  sessionId?: string;
  uiMessageId?: string;
  /**
   * Per-message model override from the chat-box picker. When set, takes
   * precedence over the user's persistent preference and the global default
   * for this single run. The next run falls back to the normal chain
   * unless the caller passes it again.
   */
  requestModel?: string;
  /**
   * Merged AGENTS.md content forwarded by the CLI host. Persisted onto
   * `session.metadata.agentsMd` on first arrival so subsequent regenerations
   * re-read it from the DB rather than asking the CLI to resend. Only set by
   * the CLI route; web/IM paths leave this undefined.
   */
  agentsMd?: string;
  /**
   * Plan-mode toggle from the CLI `/plan` slash command. When true, the
   * workflow filters its toolset to read-only / observe / reason tools
   * only — the model can investigate but not mutate state. Forwarded to
   * startWorkflow → chatWorkflow → buildAgentTools. Only meaningful for
   * CLI sources; ignored otherwise.
   */
  planMode?: boolean;
  /**
   * Thinking level from the CLI `/effort` slash command. Forwarded to
   * startWorkflow → chatWorkflow → resolveAgentProviderOptions, which
   * serializes it into the provider-specific reasoning field. 'off' /
   * undefined leaves the provider's default behavior unchanged.
   */
  thinkingLevel?: string;
  /**
   * Experimental client-spoof profile from CLI/Desktop settings. When set,
   * it overrides stored provider `client_spoof` values for this workflow run.
   */
  clientSpoof?: ClientSpoof;
};

type ChatMainOptions = {
  source?: ChatSource;
  channel?: string;
  externalThreadId?: string;
  userId?: string;
  idempotencyKey?: string;
  workflowSource?: 'scheduled';
};

type AdapterMessageInput = {
  adapter: AdapterName;
  origin: string;
  sessionId?: string;
  threadId: string;
  messageId?: string | null;
  userId?: string | null;
  userName?: string | null;
  locale?: BotLocale;
  text: string;
  parts?: ChatInputEnvelope['parts'];
};

type SessionRecord = Awaited<ReturnType<typeof getSession>> | null;

/**
 * Build the /help output for the given locale. Reuses the slash.command.*
 * descriptions so /help and the Web slash menu stay in sync.
 */
function buildCommandHelpText(locale: Locale): string {
  const header = t(locale, 'cmd.help.header');
  const entries = COMMANDS.map((cmd) => {
    const description = t(locale, `slash.command.${cmd}.description` as never);
    const hint = t(locale, `slash.command.${cmd}.hint` as never);
    return `${hint} - ${description}`;
  });
  return [header, ...entries].join('\n\n');
}

function normalizeSource(options?: ChatMainOptions): ChatSource {
  if (options?.source) {
    return options.source;
  }

  if (options?.workflowSource === 'scheduled') {
    return { type: 'scheduled' };
  }

  return { type: 'web' };
}

function buildAdapterSource(
  input: Omit<AdapterMessageInput, 'text' | 'parts'>,
): Extract<ChatSource, { type: 'im' }> {
  return {
    type: 'im',
    adapter: input.adapter,
    origin: input.origin,
    threadId: input.threadId,
    messageId: input.messageId ?? null,
    userId: input.userId ?? null,
    userName: input.userName ?? null,
    locale: input.locale,
  };
}

function buildLegacyExternalThreadId(source: ChatSource): string | null {
  if (source.type !== 'im') {
    return null;
  }

  return source.threadId;
}

function getImExternalThreadIds(source: Extract<ChatSource, { type: 'im' }>) {
  const canonical = buildExternalThreadId(source);
  const legacy = buildLegacyExternalThreadId(source);

  return [canonical, legacy].filter(
    (value, index, array): value is string =>
      typeof value === 'string' &&
      value.length > 0 &&
      array.indexOf(value) === index,
  );
}

async function lookupSessionByImSource(
  source: Extract<ChatSource, { type: 'im' }>,
): Promise<SessionRecord> {
  const [canonicalExternalThreadId, legacyExternalThreadId] =
    getImExternalThreadIds(source);

  if (!canonicalExternalThreadId) {
    return null;
  }

  const direct = await getSessionByExternalThreadId(canonicalExternalThreadId);
  if (direct) {
    return direct;
  }

  if (!legacyExternalThreadId) {
    return null;
  }

  const legacy = await getSessionByExternalThreadId(legacyExternalThreadId);
  if (!legacy) {
    return null;
  }

  return (
    (await updateSession(legacy.id, {
      channel: source.adapter,
      externalThreadId: canonicalExternalThreadId,
      userId: source.userId ?? null,
      metadata: {
        ...(legacy.metadata ?? {}),
        source,
      },
    })) ?? legacy
  );
}

async function bindImSourceToSession(
  source: Extract<ChatSource, { type: 'im' }>,
  sessionId: string,
): Promise<SessionRecord> {
  const externalThreadIds = getImExternalThreadIds(source);
  const [canonicalExternalThreadId] = externalThreadIds;

  if (!canonicalExternalThreadId) {
    return getSession(sessionId);
  }

  const [target, sessions] = await Promise.all([
    getSession(sessionId),
    listSessionsByExternalThreadIds(externalThreadIds),
  ]);

  if (!target) {
    return null;
  }

  await Promise.all(
    sessions
      .filter((session) => session.id !== sessionId)
      .map((session) => updateSession(session.id, { externalThreadId: null })),
  );

  return (
    (await updateSession(sessionId, {
      channel: source.adapter,
      externalThreadId: canonicalExternalThreadId,
      userId: source.userId ?? null,
      metadata: {
        ...(target.metadata ?? {}),
        source,
      },
    })) ?? target
  );
}

/**
 * Resolve the user id that should own a new session created from the
 * given source. Web and IM sources always carry userId when authenticated;
 * CLI sources carry it after the login handshake. Scheduled tasks have
 * no user. Returning the actual userId (instead of hardcoding null for
 * anything that isn't web/im) is required so the channel-lock check
 * doesn't immediately reject the freshly created session.
 */
function sourceUserId(source: ChatSource): string | null {
  if (source.type === 'scheduled') return null;
  return source.userId ?? null;
}

/**
 * Read the CLI-forwarded AGENTS.md content from a session's metadata blob.
 * Returns undefined when the metadata is missing or the stored value is not a
 * non-empty trimmed string. Callers gate the value on `source.type === 'cli'`
 * before passing it to buildSystemPrompt, so this helper does not need to
 * check the source itself.
 */
function readSessionAgentsMd(
  metadata: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!metadata) return undefined;
  const value = metadata.agentsMd;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function ensureMessageSession(input: {
  sessionId?: string;
  source: ChatSource;
}) {
  const externalThreadId = buildExternalThreadId(input.source);

  if (input.sessionId) {
    const existing = await getSession(input.sessionId);
    if (existing) {
      if (
        input.source.type === 'web' &&
        input.source.userId &&
        !existing.userId &&
        existing.channel === 'web'
      ) {
        return (
          (await updateSession(existing.id, {
            userId: input.source.userId,
            metadata: {
              ...(existing.metadata ?? {}),
              source: input.source,
            },
          })) ?? existing
        );
      }

      if (!canSourceAccessSession(input.source, existing)) {
        throw new Error('Forbidden');
      }

      return existing;
    }

    return createSession({
      id: input.sessionId,
      channel: currentChannelName(input.source),
      externalThreadId,
      userId: sourceUserId(input.source),
      metadata: {
        source: input.source,
      },
    });
  }

  if (input.source.type === 'im') {
    const existing = await lookupSessionByImSource(input.source);
    if (existing) {
      return existing;
    }
  }

  return createSession({
    channel: currentChannelName(input.source),
    externalThreadId,
    userId: sourceUserId(input.source),
    metadata: {
      source: input.source,
    },
  });
}

async function resolveCommandSession(input: {
  sessionId?: string;
  source: ChatSource;
}) {
  if (input.sessionId) {
    const session = await getSession(input.sessionId);
    if (session && !canSourceAccessSession(input.source, session)) {
      return null;
    }
    return session;
  }

  if (input.source.type === 'im') {
    return lookupSessionByImSource(input.source);
  }

  return null;
}

async function listSwitchableSessions(input: {
  currentSession: SessionRecord;
  source: ChatSource;
}) {
  if (input.source.type !== 'im') {
    return input.currentSession ? [input.currentSession] : [];
  }

  if (!input.source.userId) {
    return input.currentSession ? [input.currentSession] : [];
  }

  return listSessions({
    archived: false,
    channel: input.source.adapter,
    limit: 20,
    userId: input.source.userId,
  });
}

function formatSessionTitle(session: NonNullable<SessionRecord>) {
  return session.title?.trim() || 'Untitled';
}

function formatSessionList(
  sessions: NonNullable<SessionRecord>[],
  currentSessionId?: string,
) {
  if (sessions.length === 0) {
    return 'No sessions found for this IM user.';
  }

  const lines = sessions.map((session, index) => {
    const marker = session.id === currentSessionId ? '*' : ' ';
    const updatedAt = session.updatedAt.toLocaleString();
    return `${index + 1}. ${marker} ${formatSessionTitle(session)}\n   ${session.id}\n   updated ${updatedAt}`;
  });

  return [
    'Recent sessions:',
    ...lines,
    '',
    'Use /switch <number> or /switch <session-id>.',
  ].join('\n');
}

function canImSourceAccessSession(
  source: Extract<ChatSource, { type: 'im' }>,
  session: NonNullable<SessionRecord>,
) {
  return (
    session.channel === source.adapter &&
    Boolean(source.userId) &&
    session.userId === source.userId
  );
}

function canSourceAccessSession(
  source: ChatSource,
  session: NonNullable<SessionRecord>,
) {
  return evaluateSessionAccess(source, {
    userId: session.userId,
    channel: session.channel,
  }).accessible;
}

type SwitchResolveResult =
  | { kind: 'found'; session: NonNullable<SessionRecord> }
  | {
      kind: 'cross-channel';
      session: NonNullable<SessionRecord>;
      sessionChannel: string;
      currentChannel: string;
    }
  | { kind: 'not-found' };

async function resolveSwitchTarget(input: {
  args: string;
  currentSession: SessionRecord;
  source: ChatSource;
}): Promise<SwitchResolveResult> {
  const trimmed = input.args.trim();
  if (!trimmed) {
    return { kind: 'not-found' };
  }

  const candidates = await listSwitchableSessions({
    currentSession: input.currentSession,
    source: input.source,
  });

  const asNumber = Number.parseInt(trimmed, 10);
  if (
    String(asNumber) === trimmed &&
    asNumber >= 1 &&
    asNumber <= candidates.length
  ) {
    const byIndex = candidates[asNumber - 1];
    if (byIndex) {
      return { kind: 'found', session: byIndex };
    }
    return { kind: 'not-found' };
  }

  const exact =
    input.source.type === 'im' && trimmed.length >= 32
      ? await getSession(trimmed)
      : null;

  if (exact && input.source.type === 'im') {
    const access = evaluateSessionAccess(input.source, {
      userId: exact.userId,
      channel: exact.channel,
    });
    if (access.accessible) {
      return { kind: 'found', session: exact };
    }
    if (
      !access.accessible &&
      access.reason === 'cross-channel-strict' &&
      exact.userId === input.source.userId
    ) {
      return {
        kind: 'cross-channel',
        session: exact,
        sessionChannel: access.sessionChannel ?? exact.channel,
        currentChannel: access.currentChannel ?? input.source.adapter,
      };
    }
  }

  const prefixMatches = candidates.filter((session) =>
    session.id.startsWith(trimmed),
  );
  if (prefixMatches.length === 1) {
    return { kind: 'found', session: prefixMatches[0] };
  }
  return { kind: 'not-found' };
}

async function maybeAssignSessionTitle(input: {
  session: NonNullable<SessionRecord>;
  uiMessageId: string;
  text: string;
}) {
  if (input.session.title) {
    return;
  }

  const title = deriveSessionTitle(input.text);
  if (!title) {
    return;
  }

  const firstVisibleMessage = await getFirstVisibleSessionMessage(
    input.session.id,
  );
  if (firstVisibleMessage?.uiMessageId !== input.uiMessageId) {
    return;
  }

  await updateSession(input.session.id, { title });
}

function extractTextFromParsedChunk(chunk: unknown): string[] {
  if (!chunk || typeof chunk !== 'object') return [];

  const payload = chunk as Record<string, unknown>;
  if (payload.type === 'text-delta') {
    const delta = payload.delta ?? payload.textDelta;
    return typeof delta === 'string' ? [delta] : [];
  }

  if (payload.type === 'text') {
    return typeof payload.text === 'string' ? [payload.text] : [];
  }

  return [];
}

async function readTextFromReadableStream(
  stream: ReadableStream,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value instanceof Uint8Array) {
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const rawData = trimmed.startsWith('data:')
            ? trimmed.slice(5).trim()
            : trimmed;
          if (!rawData || rawData === '[DONE]') continue;

          try {
            text += extractTextFromParsedChunk(JSON.parse(rawData)).join('');
          } catch {
            continue;
          }
        }
        continue;
      }

      text += extractTextFromParsedChunk(value).join('');
    }

    buffered += decoder.decode();
    for (const line of buffered.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const rawData = trimmed.startsWith('data:')
        ? trimmed.slice(5).trim()
        : trimmed;
      if (!rawData || rawData === '[DONE]') continue;

      try {
        text += extractTextFromParsedChunk(JSON.parse(rawData)).join('');
      } catch {
        continue;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

/**
 * Fire-and-forget trigger for the IM stream-consumer endpoint.
 *
 * Builds a GET URL on this deployment's own origin carrying the runId
 * + a serialized IM source, then fetches it without awaiting. The
 * endpoint returns a streaming Response whose body stays open for the
 * duration of the workflow run; we discard that body — its sole
 * purpose is to keep the consumer function alive past maxDuration.
 *
 * Errors are swallowed: this runs in the webhook function's stack and
 * must not propagate (the webhook has already returned 200 to the IM
 * platform by the time this fetch resolves).
 */
async function triggerImStreamConsumer(input: {
  source: Extract<ChatSource, { type: 'im' }>;
  runId: string;
}): Promise<void> {
  const { source, runId } = input;
  const params = new URLSearchParams({
    runId,
    adapter: source.adapter,
    threadId: source.threadId,
  });
  if (source.userId) params.set('userId', source.userId);
  if (source.locale) params.set('locale', source.locale);

  // We AWAIT the fetch headers but NOT the body. Awaiting the headers
  // guarantees the request is actually dispatched — a detached
  // `void fetch()` chain gets GC'd when the event loop drains, and the
  // fetch may never be sent. routeAdapterMessage (our caller) runs in
  // chat-sdk's waitUntil task, so awaiting here is fine — Vercel keeps
  // the function alive for the whole waitUntil task.
  //
  // We do NOT read the response body: the stream-consumer keeps its
  // streaming Response body open for the whole workflow run. Reading it
  // would block this task (and thus the webhook function) until the run
  // finishes. Detaching lets the consumer run independently server-side.
  try {
    const { getAppBaseUrl } = await import('@/lib/bot/webhook');
    const url = `${getAppBaseUrl()}/api/internal/im-stream?${params}`;
    const resp = await fetch(url, { method: 'GET', cache: 'no-store' });
    if (!resp.ok) {
      const body = await resp.text();
      console.warn('[triggerImStreamConsumer] non-ok response', {
        status: resp.status,
        body: body.slice(0, 200),
        runId,
        adapter: source.adapter,
      });
    }
    // Body intentionally not read on success — see comment above.
  } catch (error) {
    console.warn('[triggerImStreamConsumer] fetch failed', {
      runId,
      adapter: source.adapter,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function replyToAdapterCommandResult(
  dispatched: DispatchChatInputResult,
  source: Extract<ChatSource, { type: 'im' }>,
): Promise<void> {
  if (dispatched.kind === 'message') {
    // IM replies are streamed by the dedicated stream-consumer endpoint
    // (app/api/internal/im-stream/route.ts), triggered fire-and-forget
    // from routeAdapterMessage below. Consuming run.readable here would
    // bind the stream to the webhook function's HTTP request lifetime
    // and truncate the message when the function hits maxDuration. Drop
    // it — the consumer endpoint drains a fresh copy via
    // getWorkflowRun(runId).readable.
    return;
  }

  if (dispatched.kind !== 'command') {
    return;
  }

  const text = dispatched.result.readable
    ? await readTextFromReadableStream(dispatched.result.readable)
    : dispatched.result.text;

  await sendAdapterSourceReply(source, text);
}

export async function routeAdapterMessage(
  input: AdapterMessageInput,
): Promise<DispatchChatInputResult> {
  const rawSource = buildAdapterSource(input);

  // Resolve the ClawLess user identity for this IM author. When a pairing
  // exists, the resolved ClawLess userId substitutes the IM-platform id in
  // the source so that sessions, tasks, tools, memory, and L2 cache are all
  // scoped to the ClawLess user (multi-tenant isolation). When no pairing
  // exists yet (e.g. during /pair), the IM-platform id is preserved so the
  // allowlist path still works.
  const imUserId = rawSource.userId ?? null;
  let resolvedUserId = imUserId;
  if (imUserId) {
    const clawlessUserId = await resolveClawLessUserId(
      rawSource.adapter,
      imUserId,
    );
    if (clawlessUserId) {
      resolvedUserId = clawlessUserId;
    }
  }

  // Always carry the raw IM-platform id on the source so commands that key
  // off the IM account (/whoami, /unpair, /pair) keep working after the
  // ClawLess user resolution above rewrites `userId`.
  const source: ChatSource = {
    ...rawSource,
    userId: resolvedUserId,
    rawImUserId: imUserId,
  };

  const dispatched = await chatMain(
    {
      sessionId: input.sessionId,
      trigger: 'route-message',
      input: {
        parts: input.parts ?? [{ type: 'text', text: input.text }],
        text: input.text,
      },
    },
    { source },
  );

  try {
    await replyToAdapterCommandResult(dispatched, source);
  } catch (error) {
    const logger = createLogger('chat.routeAdapterMessage');
    logger.error('reply:command_result_failed', {
      adapter: source.adapter,
      threadId: source.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Trigger the IM stream-consumer endpoint fire-and-forget. This is
  // the core of the IM streaming architecture (see stream.md):
  //
  // - The webhook function must return a fast 200 ACK so the IM
  //   platform doesn't retry, so it cannot host the stream consumer.
  // - The workflow runtime forbids setInterval and can't serialize
  //   experimental_transform, so it can't host it either.
  // - The stream-consumer endpoint is a plain Node.js function whose
  //   HTTP Response body is itself a ReadableStream — that streaming
  //   response keeps the function alive past Vercel's maxDuration (the
  //   same trick the web chat route uses), letting it drain the whole
  //   workflow readable, post + editMessage on a throttled cadence,
  //   and refresh typing for the entire run.
  //
  // We DO NOT await this fetch — awaiting would block routeAdapterMessage,
  // which chat-sdk's processMessage awaits in turn, which would block
  // the webhook ACK. The fetch resolves quickly (the stream-consumer
  // returns a streaming Response immediately); the actual work continues
  // server-side for as long as the stream is open.
  if (
    source.type === 'im' &&
    (dispatched.kind === 'message' || dispatched.kind === 'resume-run-message')
  ) {
    await triggerImStreamConsumer({
      source,
      runId: dispatched.result.runId,
    });
  }

  return dispatched;
}

async function executeCommand(input: {
  command: Command;
  args: string;
  currentSession: SessionRecord;
  requestedSessionId?: string;
  source: ChatSource;
}) {
  const session = input.currentSession;
  const runtime = session ? await getSessionRuntime(session.id) : null;
  const currentSessionId = session?.id ?? input.requestedSessionId ?? 'none';

  // Get locale from session metadata, IM source, or default
  const rawLocale =
    (session?.metadata?.locale as string) ||
    (input.source.type === 'im' ? input.source.locale : undefined) ||
    'en-US';
  const locale: Locale = (rawLocale === 'auto' ? 'en-US' : rawLocale) as Locale;

  switch (input.command) {
    case 'help':
      return {
        sessionId: currentSessionId,
        text: buildCommandHelpText(locale),
        runId: session?.workflowRunId ?? null,
      };
    case 'status': {
      if (!session) {
        return {
          sessionId: 'none',
          text: t(locale, 'cmd.status.noSession'),
          runId: null,
        };
      }

      const source = session.metadata?.source as
        | Record<string, unknown>
        | undefined;
      const sourceText =
        source && source.type === 'im'
          ? `im:${String(source.adapter)} origin=${String(source.origin)} thread=${String(source.threadId)}`
          : (session.channel ?? 'web');
      const latestApproval =
        (session.metadata?.latestApproval as
          | {
              toolCallId?: string;
              toolName?: string;
              status?: string;
            }
          | undefined) ?? undefined;

      return {
        sessionId: session.id,
        text: [
          `session=${session.id}`,
          `run=${runtime?.workflow.runId ?? 'none'}`,
          `status=${runtime?.workflow.status ?? 'idle'}`,
          `phase=${runtime?.workflow.phase ?? 'idle'}`,
          `model=${session.model ?? 'unset'}`,
          `tokens=${session.totalTokens ?? 0}`,
          `source=${sourceText}`,
          latestApproval?.toolCallId
            ? `approval=${latestApproval.status ?? 'pending'} ${latestApproval.toolName ?? ''} ${latestApproval.toolCallId}`.trim()
            : 'approval=none',
        ].join('\n\n'),
        runId: session.workflowRunId ?? null,
      };
    }
    case 'session': {
      if (!input.args) {
        return {
          sessionId: currentSessionId,
          text: `current-session=${currentSessionId}`,
          runId: session?.workflowRunId ?? null,
        };
      }

      if (input.source.type !== 'im') {
        return {
          sessionId: currentSessionId,
          text: t(locale, 'cmd.session.switch.imOnly'),
          runId: session?.workflowRunId ?? null,
        };
      }

      const target = await resolveSwitchTarget({
        args: input.args,
        currentSession: session,
        source: input.source,
      });
      if (target.kind === 'not-found') {
        return {
          sessionId: currentSessionId,
          text: t(locale, 'cmd.session.notFound', { args: input.args }),
          runId: session?.workflowRunId ?? null,
        };
      }
      if (target.kind === 'cross-channel') {
        return {
          sessionId: currentSessionId,
          text: t(locale, 'cmd.session.crossChannel', {
            sessionChannel: target.sessionChannel,
            currentChannel: target.currentChannel,
          }),
          runId: session?.workflowRunId ?? null,
        };
      }

      const rebound = await bindImSourceToSession(
        input.source,
        target.session.id,
      );

      return {
        sessionId: rebound?.id ?? target.session.id,
        text: t(locale, 'cmd.session.switched', {
          sessionId: target.session.id,
        }),
        runId: target.session.workflowRunId ?? null,
      };
    }
    case 'sessions': {
      if (input.source.type !== 'im') {
        return {
          sessionId: currentSessionId,
          text: t(locale, 'cmd.session.list.imOnly'),
          runId: session?.workflowRunId ?? null,
        };
      }

      const sessions = await listSwitchableSessions({
        currentSession: session,
        source: input.source,
      });

      return {
        sessionId: currentSessionId,
        text: formatSessionList(sessions, session?.id),
        runId: session?.workflowRunId ?? null,
      };
    }
    case 'switch': {
      if (input.source.type !== 'im') {
        return {
          sessionId: currentSessionId,
          text: t(locale, 'cmd.session.switch.imOnly'),
          runId: session?.workflowRunId ?? null,
        };
      }

      if (!input.args.trim()) {
        const sessions = await listSwitchableSessions({
          currentSession: session,
          source: input.source,
        });
        return {
          sessionId: currentSessionId,
          text: formatSessionList(sessions, session?.id),
          runId: session?.workflowRunId ?? null,
        };
      }

      const target = await resolveSwitchTarget({
        args: input.args,
        currentSession: session,
        source: input.source,
      });

      if (target.kind === 'not-found') {
        return {
          sessionId: currentSessionId,
          text: t(locale, 'cmd.session.notFound', { args: input.args }),
          runId: session?.workflowRunId ?? null,
        };
      }

      if (target.kind === 'cross-channel') {
        return {
          sessionId: currentSessionId,
          text: t(locale, 'cmd.session.crossChannel', {
            sessionChannel: target.sessionChannel,
            currentChannel: target.currentChannel,
          }),
          runId: session?.workflowRunId ?? null,
        };
      }

      const rebound = await bindImSourceToSession(
        input.source,
        target.session.id,
      );

      return {
        sessionId: rebound?.id ?? target.session.id,
        text: t(locale, 'cmd.session.switched', {
          sessionId: target.session.id,
        }),
        runId: target.session.workflowRunId ?? null,
      };
    }
    case 'delete_session': {
      if (input.source.type !== 'im') {
        return {
          sessionId: currentSessionId,
          text: t(locale, 'cmd.session.delete.imOnly'),
          runId: session?.workflowRunId ?? null,
        };
      }

      const resolved = input.args.trim()
        ? await resolveSwitchTarget({
            args: input.args,
            currentSession: session,
            source: input.source,
          })
        : null;
      const target =
        resolved === null
          ? (session ?? null)
          : resolved.kind === 'found'
            ? resolved.session
            : resolved.kind === 'cross-channel'
              ? resolved.session
              : null;

      if (!target) {
        return {
          sessionId: currentSessionId,
          text: input.args.trim()
            ? t(locale, 'cmd.session.notFound', { args: input.args })
            : t(locale, 'cmd.session.noActive'),
          runId: session?.workflowRunId ?? null,
        };
      }

      if (
        resolved?.kind === 'cross-channel' ||
        !canImSourceAccessSession(input.source, target)
      ) {
        if (resolved?.kind === 'cross-channel') {
          return {
            sessionId: currentSessionId,
            text: t(locale, 'cmd.session.crossChannel', {
              sessionChannel: resolved.sessionChannel,
              currentChannel: resolved.currentChannel,
            }),
            runId: session?.workflowRunId ?? null,
          };
        }
        return {
          sessionId: currentSessionId,
          text: t(locale, 'cmd.session.deleteNotAllowed'),
          runId: session?.workflowRunId ?? null,
        };
      }

      const deletedSessionId = target.id;
      const cleanup = await cleanupChatSession(target);

      return {
        sessionId:
          session?.id && session.id !== deletedSessionId ? session.id : 'none',
        text: `${t(locale, 'cmd.session.deleted', { sessionId: deletedSessionId })}\n${t(locale, 'cmd.session.cleanupSummary', { workflowCancelled: String(cleanup.workflowCancelled), daemonAborted: String(cleanup.daemonAborted), sandboxStopped: String(cleanup.sandboxStopped), scheduleRunsCancelled: String(cleanup.scheduleRunsCancelled) })}`,
        runId: null,
      };
    }
    case 'stop': {
      if (!session) {
        return {
          sessionId: 'none',
          text: t(locale, 'cmd.status.noSession'),
          runId: null,
        };
      }

      if (!runtime?.workflow.runId) {
        return {
          sessionId: session.id,
          text: 'No active workflow run.',
          runId: null,
        };
      }

      await pauseWorkflow(runtime.workflow.runId);
      return {
        sessionId: session.id,
        text: t(locale, 'cmd.stop.success', {
          runId: runtime.workflow.runId,
        }),
        runId: null,
      };
    }
    case 'init': {
      return {
        sessionId: currentSessionId,
        text: '__INIT_AGENTS_MD__',
        runId: session?.workflowRunId ?? null,
      };
    }
    case 'compact': {
      if (!session) {
        return {
          sessionId: 'none',
          text: t(locale, 'cmd.status.noSession'),
          runId: null,
        };
      }

      if (!runtime?.workflow.runId) {
        return {
          sessionId: session.id,
          text: 'No active workflow run to compact.',
          runId: null,
        };
      }

      const queued = await requestCompact(runtime.workflow.runId);
      if (!queued) {
        return {
          sessionId: session.id,
          text: 'No active workflow run to compact.',
          runId: null,
        };
      }

      return {
        sessionId: session.id,
        text: `Queued compaction for run ${runtime.workflow.runId}.`,
        runId: session.workflowRunId ?? null,
      };
    }
    case 'approve':
    case 'reject': {
      if (!session) {
        return {
          sessionId: 'none',
          text: t(locale, 'cmd.status.noSession'),
          runId: null,
        };
      }

      const pending =
        (session.metadata?.latestApproval as
          | { toolCallId?: string; status?: string; hookToken?: string }
          | undefined) ?? undefined;
      const [explicitToolCallId = '', ...rest] = input.args.split(/\s+/);
      const comment = rest.join(' ').trim();
      const toolCallId = explicitToolCallId || pending?.toolCallId || '';
      const candidateHookTokens = Array.from(
        new Set(
          [
            pending?.hookToken,
            runtime?.workflow.runId
              ? `${runtime.workflow.runId}:${toolCallId}`
              : undefined,
            toolCallId,
          ].filter((value): value is string => Boolean(value)),
        ),
      );

      if (!toolCallId) {
        return {
          sessionId: session.id,
          text: `No pending approval found for /${input.command}.`,
          runId: session.workflowRunId ?? null,
        };
      }

      let resolvedHookToken: string | null = null;
      let lastResumeError: unknown = null;

      for (const hookToken of candidateHookTokens) {
        try {
          await resumeToolApproval(hookToken, {
            approved: input.command === 'approve',
            comment: comment || undefined,
            toolCallId,
          });
          resolvedHookToken = hookToken;
          break;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (!message.toLowerCase().includes('hook not found')) {
            throw error;
          }
          lastResumeError = error;
        }
      }

      if (!resolvedHookToken) {
        throw (
          lastResumeError ??
          new Error('No matching approval hook was found for this tool call.')
        );
      }

      await updateSession(session.id, {
        metadata: {
          ...(session.metadata ?? {}),
          latestApproval: {
            toolCallId,
            hookToken: resolvedHookToken,
            status: input.command === 'approve' ? 'approved' : 'rejected',
            comment: comment || null,
          },
        },
      });

      return {
        sessionId: session.id,
        text:
          input.command === 'approve'
            ? t(locale, 'cmd.approve.ok', { toolCallId })
            : t(locale, 'cmd.reject.ok', { toolCallId }),
        runId: session.workflowRunId ?? null,
      };
    }
    case 'new': {
      if (input.source.type === 'im') {
        const next = await createSession({
          channel: input.source.adapter,
          userId: input.source.userId ?? null,
          metadata: {
            source: input.source,
          },
        });
        const rebound = await bindImSourceToSession(input.source, next.id);

        return {
          sessionId: rebound?.id ?? next.id,
          text: `Created and switched to session ${next.id}.`,
          runId: null,
        };
      }

      const next = await createSession({
        channel: session?.channel ?? 'web',
        userId:
          input.source.type === 'web' ? (input.source.userId ?? null) : null,
      });

      return {
        sessionId: next.id,
        text: `Created session ${next.id}.`,
        runId: null,
      };
    }
    case 'model': {
      const text = await executeModelCommand(input.args, {
        userId:
          input.source.type === 'im' || input.source.type === 'web'
            ? (input.source.userId ?? null)
            : null,
        sessionId: session?.id ?? null,
      });
      return {
        sessionId: currentSessionId,
        text,
        runId: session?.workflowRunId ?? null,
      };
    }
    case 'provider': {
      const text = await executeProviderCommand(input.args);
      return {
        sessionId: currentSessionId,
        text,
        runId: session?.workflowRunId ?? null,
      };
    }
    case 'config': {
      const text = await executeConfigCommand(input.args);
      return {
        sessionId: currentSessionId,
        text,
        runId: session?.workflowRunId ?? null,
      };
    }
    case 'memory': {
      const text = await executeMemoryCommand(input.args);
      return {
        sessionId: currentSessionId,
        text,
        runId: session?.workflowRunId ?? null,
      };
    }
    case 'pair': {
      const imSource = input.source.type === 'im' ? input.source : null;
      if (!imSource) {
        return {
          sessionId: currentSessionId,
          text: '/pair is only available in IM channels.',
          runId: session?.workflowRunId ?? null,
        };
      }
      const text = await executePairCommand(
        input.args,
        imSource.adapter,
        imSource.rawImUserId ?? null,
        imSource.userName ?? null,
      );
      return {
        sessionId: currentSessionId,
        text,
        runId: session?.workflowRunId ?? null,
      };
    }
    case 'unpair': {
      const imSource = input.source.type === 'im' ? input.source : null;
      if (!imSource) {
        return {
          sessionId: currentSessionId,
          text: '/unpair is only available in IM channels.',
          runId: session?.workflowRunId ?? null,
        };
      }
      const text = await executeUnpairCommand(
        imSource.adapter,
        imSource.rawImUserId ?? null,
      );
      return {
        sessionId: currentSessionId,
        text,
        runId: session?.workflowRunId ?? null,
      };
    }
    case 'start': {
      const imSource = input.source.type === 'im' ? input.source : null;
      const result = await executeStartCommand(locale, {
        adapter: imSource?.adapter ?? null,
        imUserId: imSource?.rawImUserId ?? null,
      });
      return {
        sessionId: currentSessionId,
        text: result.text,
        runId: session?.workflowRunId ?? null,
      };
    }
    case 'version': {
      const result = executeVersionCommand(locale);
      return {
        sessionId: currentSessionId,
        text: result.text,
        runId: session?.workflowRunId ?? null,
      };
    }
    case 'id': {
      const result = executeIdCommand(locale, {
        sessionId: session?.id ?? null,
        userId:
          input.source.type === 'im' ? (input.source.userId ?? null) : null,
        source:
          input.source.type === 'im'
            ? {
                adapter: input.source.adapter,
                threadId: input.source.threadId,
              }
            : null,
      });
      return {
        sessionId: currentSessionId,
        text: result.text,
        runId: session?.workflowRunId ?? null,
      };
    }
    case 'whoami': {
      const imSource = input.source.type === 'im' ? input.source : null;
      const text = await executeWhoamiCommand(
        imSource?.adapter ?? null,
        imSource?.rawImUserId ?? null,
      );
      return {
        sessionId: currentSessionId,
        text,
        runId: session?.workflowRunId ?? null,
      };
    }
    case 'cancel': {
      const result = await executeCancelCommand(locale, {
        sessionId: session?.id ?? null,
        runId: runtime?.workflow.runId ?? null,
      });
      return {
        sessionId: currentSessionId,
        text: result.text,
        runId: null,
      };
    }
    case 'reset': {
      const result = await executeResetCommand(locale, {
        sessionId: session?.id ?? null,
      });
      return {
        sessionId: currentSessionId,
        text: result.text,
        runId: session?.workflowRunId ?? null,
      };
    }
    case 'retry': {
      const result = await executeRetryCommand(locale, {
        sessionId: session?.id ?? null,
      });
      if (result.shouldRetry) {
        return {
          sessionId: currentSessionId,
          text: t(locale, 'cmd.retry.retrying'),
          runId: session?.workflowRunId ?? null,
        };
      }
      return {
        sessionId: currentSessionId,
        text: result.text ?? t(locale, 'cmd.retry.failed'),
        runId: session?.workflowRunId ?? null,
      };
    }
    case 'lang': {
      const result = await executeLangCommand(locale, {
        args: input.args,
        sessionId: session?.id ?? null,
      });
      return {
        sessionId: currentSessionId,
        text: result.text,
        runId: session?.workflowRunId ?? null,
      };
    }
    case 'attach': {
      return executeAttachCommand({
        args: input.args,
        currentSession: session,
        source: input.source,
        locale,
      });
    }
    case 'detach': {
      return executeDetachCommand({
        currentSession: session,
        source: input.source,
        locale,
      });
    }
    case 'remote': {
      return executeRemoteCommand({
        currentSession: session,
        source: input.source,
        locale,
      });
    }
    default:
      return {
        sessionId: currentSessionId,
        text: t(locale, 'cmd.unsupported', { command: input.command }),
        runId: session?.workflowRunId ?? null,
      };
  }
}

export async function chatMain(
  request: LegacyChatMainRequest,
  options?: ChatMainOptions,
): Promise<DispatchChatInputResult> {
  chatMainLogger.info('chatMain:start', { sessionId: request.sessionId });

  const source = normalizeSource(options);
  chatMainLogger.info('chatMain:source_normalized', {
    sourceType: source.type,
  });

  // Remote control routing: if this is an IM message and the IM thread is
  // attached to a CLI session, route the message to that CLI session instead
  // of the IM session. Skip if already routed (remoteIm) to prevent recursion.
  if (source.type === 'im' && !source.remoteIm) {
    const { getAttachedSessionId, isCliOnlineForSession } = await import(
      '@/lib/cli/remote-control'
    );
    const targetSessionId = await getAttachedSessionId(
      source.adapter,
      source.threadId,
    );

    if (targetSessionId) {
      const cliOnline = await isCliOnlineForSession(targetSessionId);
      if (cliOnline) {
        chatMainLogger.info('chatMain:routing_to_cli', {
          imThread: source.threadId,
          targetSession: targetSessionId,
        });

        // Route to the target CLI session by overriding the sessionId
        return chatMain(
          { ...request, sessionId: targetSessionId },
          {
            ...options,
            source: {
              ...source,
              // Mark this as remote-controlled so downstream logic can adjust
              // (e.g., tool registration enables local_* and computer-use tools,
              // L2 approval routing back to IM instead of CLI prompt)
              remoteIm: true,
              remoteAdapter: source.adapter,
              remoteThreadId: source.threadId,
            } as ChatSource,
          },
        );
      }

      chatMainLogger.warn('chatMain:cli_offline', {
        imThread: source.threadId,
        targetSession: targetSessionId,
      });
      // CLI is offline — fully detach (KV + DB) and continue with normal IM session
      const { clearImAttachment } = await import('@/lib/cli/remote-control');
      await clearImAttachment(source.adapter, source.threadId);
      const { db } = await import('@/lib/core/db');
      const { sessions } = await import('@/lib/core/db/schema');
      const { eq } = await import('drizzle-orm');
      await db.update(sessions).set({ remoteControlNodeId: null }).where(eq(sessions.id, targetSessionId));
    }
  }

  const envelope = parseChatInputEnvelope({
    sessionId: request.sessionId,
    uiMessageId: request.uiMessageId ?? generateUUID(),
    parts: request.input.parts,
    text: request.input.text,
    source,
  });
  chatMainLogger.info('chatMain:envelope_parsed', { kind: envelope.kind });

  if (envelope.kind === 'command') {
    chatMainLogger.info('chatMain:processing_command', {
      command: envelope.command,
    });
    const currentSession = await resolveCommandSession({
      sessionId: envelope.sessionId,
      source: envelope.source,
    });
    const command = await executeCommand({
      command: envelope.command,
      args: envelope.args,
      currentSession,
      requestedSessionId: envelope.sessionId,
      source: envelope.source,
    });

    if (command.text === INIT_AGENTS_MD_MARKER) {
      chatMainLogger.info('chatMain:init_agents_md_workflow');
      return runInitAgentsMdWorkflow({
        sessionId: command.sessionId ?? 'none',
        source: envelope.source,
        currentSession,
      });
    }

    chatMainLogger.info('chatMain:command_completed');
    return {
      kind: 'command',
      result: {
        sessionId: command.sessionId ?? 'none',
        text: command.text,
        runId: command.runId ?? null,
      },
    };
  }

  if (
    envelope.kind === 'message' &&
    source.type === 'im' &&
    !envelope.sessionId
  ) {
    chatMainLogger.info('chatMain:checking_duplicate');
    const dedup = await checkDuplicate(source, envelope.text, {
      idempotencyKey: options?.idempotencyKey,
      messageId: source.messageId ?? undefined,
    });
    if (dedup) {
      chatMainLogger.info('chatMain:duplicate_detected');
      return {
        kind: 'command',
        result: {
          sessionId: dedup.sessionId,
          text: `Active session: ${dedup.sessionId.slice(0, 8)}…\nSimilar task detected (${(dedup.similarity * 100).toFixed(0)}% match).\nReply 'confirm' to proceed, or /new to start fresh.`,
          runId: null,
        },
      };
    }
  }

  if (
    envelope.kind === 'message' &&
    source.type !== 'im' &&
    options?.idempotencyKey &&
    !envelope.sessionId
  ) {
    const dedup = await checkIdempotencyDuplicate(options.idempotencyKey);
    if (dedup) {
      return {
        kind: 'command',
        result: {
          sessionId: dedup.sessionId,
          text: `Active session: ${dedup.sessionId.slice(0, 8)}…\nDuplicate request detected by idempotency key.`,
          runId: null,
        },
      };
    }
  }

  chatMainLogger.info('chatMain:ensuring_session');
  const session = await ensureMessageSession({
    sessionId: envelope.sessionId,
    source: envelope.source,
  });
  chatMainLogger.info('chatMain:session_ready', { sessionId: session.id });

  if (envelope.kind === 'message' && envelope.sessionId) {
    assertSessionWritable(source, {
      id: session.id,
      userId: session.userId,
      channel: session.channel,
    });
  }

  // Persist forwarded AGENTS.md content from the CLI onto the session so
  // regenerations (which don't resend it) and resumptions can re-read it
  // from the DB. Skipped when the request didn't include agentsMd.
  if (request.agentsMd && request.agentsMd.trim().length > 0) {
    const trimmed = request.agentsMd.trim();
    const existing = (session.metadata ?? {}) as Record<string, unknown>;
    if (existing.agentsMd !== trimmed) {
      chatMainLogger.info('chatMain:persisting_agents_md', {
        sessionId: session.id,
        length: trimmed.length,
      });
      await updateSession(session.id, {
        metadata: { ...existing, agentsMd: trimmed },
      });
      session.metadata = { ...existing, agentsMd: trimmed };
    }
  }

  if (envelope.kind === 'message' && source.type === 'im') {
    await recordMessage(source, envelope.text, session.id, {
      idempotencyKey: options?.idempotencyKey,
      messageId: source.messageId ?? undefined,
    });
  } else if (envelope.kind === 'message' && options?.idempotencyKey) {
    await recordIdempotencyMessage(
      options.idempotencyKey,
      envelope.text,
      session.id,
    );
  }

  const isRegenerate = request.trigger === 'regenerate-message';

  if (isRegenerate && session.workflowRunId) {
    chatMainLogger.info('chatMain:checking_resume', {
      runId: session.workflowRunId,
    });
    const resumable = await canResumeRun(session.workflowRunId);
    if (resumable) {
      await pauseWorkflow(session.workflowRunId);
    }
  }

  chatMainLogger.info('chatMain:normalizing_input');
  const normalizedInput = await normalizeUserMessageParts({
    sessionId: session.id,
    parts: envelope.parts,
    source: envelope.source,
  });
  const normalizedText = normalizeMessageText(
    envelope.text || normalizedInput.text,
  );
  chatMainLogger.info('chatMain:input_normalized', {
    textLength: normalizedText.length,
  });

  const nextUiMessageId = envelope.uiMessageId ?? generateUUID();

  // Metadata can come from two sources:
  // 1. Explicitly passed in request.input.metadata (preferred, avoids race)
  // 2. Fallback: load from database if regenerating an existing message
  let messageMetadata = request.input.metadata;

  if (!messageMetadata && request.trigger === 'regenerate-message') {
    // Load existing message from database to preserve metadata
    const existingMessage = await getMessageByUiMessageId(
      session.id,
      nextUiMessageId,
    );
    if (existingMessage) {
      messageMetadata = existingMessage.payload?.metadata as
        | ChatMessageMetadata
        | undefined;
      chatMainLogger.info('chatMain:loaded_metadata_from_db', {
        messageId: nextUiMessageId,
        hasMetadata: !!messageMetadata,
      });
    }
  }

  if (messageMetadata?.versions) {
    chatMainLogger.info('chatMain:found_versions', {
      messageId: nextUiMessageId,
      versionsLength: messageMetadata.versions.length,
      currentVersionIndex: messageMetadata.currentVersionIndex,
    });
  } else {
    chatMainLogger.info('chatMain:no_versions', {
      messageId: nextUiMessageId,
      hasInputMetadata: !!request.input.metadata,
      hasLoadedMetadata: !!messageMetadata,
      trigger: request.trigger,
    });
  }

  chatMainLogger.info('chatMain:upserting_user_message');
  await upsertUserMessage(
    serializeUserMessage({
      sessionId: session.id,
      uiMessageId: nextUiMessageId,
      text: normalizedText,
      parts: normalizedInput.parts,
      attachments: normalizedInput.attachments,
      source: envelope.source,
      metadata: messageMetadata,
    }),
  );
  chatMainLogger.info('chatMain:user_message_upserted');

  chatMainLogger.info('chatMain:deleting_old_messages');
  const truncated = await deleteMessagesAfterUiMessageId(
    session.id,
    nextUiMessageId,
  );
  chatMainLogger.info('chatMain:old_messages_deleted', {
    truncatedCount: truncated.length,
  });

  if (isRegenerate || truncated.length > 0) {
    await invalidateCurrentSessionSummary(session.id);
    await updateSession(session.id, {
      metadata: {
        ...(session.metadata ?? {}),
        contextUsage: null,
        latestApproval: null,
      },
    });
  }

  chatMainLogger.info('chatMain:assigning_session_title');
  await maybeAssignSessionTitle({
    session,
    uiMessageId: nextUiMessageId,
    text: normalizedText,
  });

  if (
    !isRegenerate &&
    session.workflowRunId &&
    (await canResumeRun(session.workflowRunId))
  ) {
    chatMainLogger.info('chatMain:resuming_workflow', {
      runId: session.workflowRunId,
    });
    await resumeWithMessage(session.workflowRunId, {
      type: 'user-message',
      message: normalizedText,
      parts: normalizedInput.parts,
      uiMessageId: nextUiMessageId,
    });

    return {
      kind: 'resume-run-message',
      result: {
        sessionId: session.id,
        runId: session.workflowRunId,
      },
    };
  }

  chatMainLogger.info('chatMain:fetching_config');
  const config = await getConfig();
  chatMainLogger.info('chatMain:config_fetched');

  const userId =
    envelope.source.type === 'web' || envelope.source.type === 'im'
      ? (envelope.source.userId ?? null)
      : null;
  const user = userId ? await getUserById(userId) : null;

  const effectiveModelId =
    request.requestModel ??
    session.model ??
    user?.modelPreferences?.model ??
    config.models?.model ??
    null;

  chatMainLogger.info('chatMain:building_initial_messages', {
    effectiveModelId,
    modelSource: request.requestModel
      ? 'request'
      : session.model
        ? 'session'
        : user?.modelPreferences?.model
          ? 'user-pref'
          : config.models?.model
            ? 'global'
            : 'none',
  });
  const initialMessages = await buildInitialContextMessages(session.id, {
    modelId: effectiveModelId,
    recallUserId: userId,
    recallQuery: request.input.text ?? null,
    config,
  });
  chatMainLogger.info('chatMain:initial_messages_built', {
    messageCount: initialMessages.length,
  });

  chatMainLogger.info('chatMain:starting_workflow');
  const agentsMd = readSessionAgentsMd(session.metadata);
  const { runId, readable } = await startWorkflow({
    sessionId: session.id,
    initialMessages,
    config,
    source: envelope.source,
    user,
    // Forward only the per-message pick, not the resolved effective id.
    // user-pref / global are already consulted inside chatWorkflow's
    // resolver, so passing effectiveModelId here would be redundant and
    // would mask the "request actually came from picker" intent in logs.
    requestModel: request.requestModel,
    // Inject the CLI-forwarded AGENTS.md content (now persisted on the
    // session). chatWorkflow forwards it to buildSystemPrompt for CLI
    // sources only; web/IM sessions never set this.
    agentsMd,
    // Forward the CLI /plan toggle so the workflow filters its toolset
    // to read-only / observe / reason tools in plan mode. Other sources
    // never set this and run in normal execution mode.
    planMode: request.planMode,
    // Forward the CLI /effort thinking level so resolveAgentProviderOptions
    // can serialize it into the provider-specific reasoning field.
    thinkingLevel: request.thinkingLevel,
    // Forward the CLI/Desktop client-spoof setting as a per-run provider
    // configuration override.
    clientSpoof: request.clientSpoof,
  });
  chatMainLogger.info('chatMain:workflow_started', { runId });

  return {
    kind: 'message',
    result: {
      sessionId: session.id,
      runId,
      readable,
    },
  };
}

async function runInitAgentsMdWorkflow(input: {
  sessionId: string;
  source: ChatSource;
  currentSession: SessionRecord;
}): Promise<DispatchChatInputResult> {
  const session = await ensureMessageSession({
    sessionId: input.currentSession?.id ?? input.sessionId,
    source: input.source,
  });

  const initUiMessageId = generateUUID();
  await upsertUserMessage(
    serializeUserMessage({
      sessionId: session.id,
      uiMessageId: initUiMessageId,
      text: INIT_AGENTS_MD_PROMPT,
      source: input.source,
    }),
  );

  const config = await getConfig();

  const userId =
    input.source.type === 'web' || input.source.type === 'im'
      ? (input.source.userId ?? null)
      : null;
  const user = userId ? await getUserById(userId) : null;

  const effectiveModelId =
    user?.modelPreferences?.model ?? config.models?.model ?? null;

  const initialMessages = await buildInitialContextMessages(session.id, {
    modelId: effectiveModelId,
    config,
  });

  const { runId, readable } = await startWorkflow({
    sessionId: session.id,
    initialMessages,
    config,
    source: input.source,
    user,
  });

  return {
    kind: 'message',
    result: {
      sessionId: session.id,
      runId,
      readable,
    },
  };
}
