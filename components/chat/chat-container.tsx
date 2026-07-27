'use client';

import {
  controlSessionRuntimeAction,
  deleteSessionAction,
  getChatUiSettingsAction,
  saveSessionModelAction,
  saveSessionPersonaAction,
  updateSessionTitleAction,
} from '@/app/(chat)/actions';
import { useChat } from '@ai-sdk/react';
import {
  type ChatRequestOptions,
  type CreateUIMessage,
  DefaultChatTransport,
} from 'ai';
import { ofetch } from 'ofetch';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Trash2, Plus } from 'lucide-react';
import { useLocalStorage } from 'usehooks-ts';

import { ChatHeader } from '@/components/chat-header';
import { useI18n } from '@/components/i18n-provider';
import { MobileDrawerBridge } from '@/components/mobile-drawer-bridge';
import { SessionRuntimePanel } from '@/components/session-runtime-panel';
import { Button } from '@/components/ui/button';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { getUserModelPreferencesAction } from '@/app/(config)/actions';
import {
  invalidateSessionList,
  upsertSessionListItem,
} from '@/lib/chat/session-events';
import {
  buildChatSendRequestBody,
  cloneUIParts,
  extractTextFromParts,
} from '@/lib/chat/transport-request';
import { deriveSessionTitle } from '@/lib/chat/session-title';
import { buildInlineFollowUpText } from '@/lib/chat/follow-up';
import { usePendingDecisions } from '@/lib/chat/use-pending-decisions';
import { useStreamRecovery } from '@/lib/chat/use-stream-recovery';
import { useAppConfig } from '@/hooks/use-app-config';
import { readTtsAutoplay, useTtsAutoplay } from '@/hooks/use-tts-autoplay';
import { generateUUID } from '@/lib/utils';
import {
  type WorkflowStatusData,
  type WorkflowUIMessage,
  chatMessageMetadataSchema,
} from '@/types/workflow';
import { MultimodalInput } from './chat-input';
import { ChatSidebar } from './chat-sidebar';
import { Messages } from './message-list';

type SessionRuntimeSnapshot = {
  workflow?: { runId?: string | null; status?: string | null };
};

type ChatSession = {
  id: string;
  title: string | null;
  channel: string;
  externalThreadId: string | null;
  model: string | null;
  /**
   * Selected persona (agentName) persisted via saveSessionPersonaAction.
   * Optional — older sessions don't have it. Read by chatMain on regenerate
   * when the request body doesn't carry an explicit `agent`.
   */
  metadata?: { agent?: string | null } | null;
  accessDenied?: boolean;
  readOnlyChannel?: { sessionChannel: string } | null;
} | null;

type ComposerMessage = { text: string } | CreateUIMessage<WorkflowUIMessage>;
type ToolApprovalInput = {
  toolCallId: string;
  toolName: string;
  action: 'approve' | 'reject';
  comment?: string;
};

function getStreamingRunId(
  runtime: SessionRuntimeSnapshot | null,
): string | null {
  if (
    runtime?.workflow?.runId &&
    (runtime.workflow.status === 'running' ||
      runtime.workflow.status === 'pending')
  ) {
    return runtime.workflow.runId;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function _extractLatestUserInput(messages: WorkflowUIMessage[]): {
  parts: WorkflowUIMessage['parts'];
} {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && Array.isArray(message.parts)) {
      return {
        parts: message.parts,
      };
    }
  }

  throw new Error('Missing latest user input for chat request.');
}

function cloneMessages(messages: WorkflowUIMessage[]): WorkflowUIMessage[] {
  return JSON.parse(JSON.stringify(messages)) as WorkflowUIMessage[];
}

function applySelectedModelOption(
  options: ChatRequestOptions | undefined,
  selectedModel: string | null,
): ChatRequestOptions | undefined {
  if (!selectedModel) {
    return options;
  }

  const bodyRecord = isRecord(options?.body) ? options.body : {};

  return {
    ...options,
    body: {
      ...bodyRecord,
      model: selectedModel,
    },
  };
}

/**
 * Inject the selected persona (`agent`) into the chat request body, mirroring
 * applySelectedModelOption. null/undefined = 'main' (default) and is omitted
 * so the body stays minimal on the default path.
 */
function applySelectedAgentOption(
  options: ChatRequestOptions | undefined,
  selectedAgent: string | null,
): ChatRequestOptions | undefined {
  if (!selectedAgent) {
    return options;
  }
  const bodyRecord = isRecord(options?.body) ? options.body : {};
  return {
    ...options,
    body: {
      ...bodyRecord,
      agent: selectedAgent,
    },
  };
}

export function Chat({
  id,
  initialMessages = [],
  session,
}: {
  id: string;
  initialMessages?: WorkflowUIMessage[];
  session?: ChatSession;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const activeRunIdRef = useRef<string | null>(null);
  const shouldBootstrapSessionStatusRef = useRef(false);
  const resumeInFlightRef = useRef(false);
  const statusRef = useRef<'submitted' | 'streaming' | 'ready' | 'error'>(
    'ready',
  );
  // useChat holds its Chat instance in a useRef that is only recreated
  // when the `id` option changes. With PPR enabled on the chat route,
  // the page streams in two passes: a static shell (where the dynamic
  // getVisibleSessionMessages query hasn't resolved yet, so
  // initialMessages is []) followed by the real data. useChat latches
  // onto the empty array on first render and never picks up the
  // subsequently-arriving messages. Track the initialMessages we've
  // handed to useChat so we can inject them once they actually arrive.
  const hydratedMessagesRef = useRef<WorkflowUIMessage[] | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [composerFocusKey, setComposerFocusKey] = useState(0);
  const [sessionState, setSessionState] = useState<ChatSession>(
    session ?? null,
  );
  const [tokenUsage, setTokenUsage] = useState<{
    input: number;
    output: number;
    total: number;
  } | null>(null);
  const [latestRuntimeEvent, setLatestRuntimeEvent] =
    useState<WorkflowStatusData | null>(null);
  const [bootstrapStatusRunId, setBootstrapStatusRunId] = useState<
    string | null
  >(null);

  // Chat-box model picker state. Keep the active session model as the source
  // of truth and only fall back to the last local pick when the session is new.
  const [draftModel, setDraftModel] = useLocalStorage<string | null>(
    'chat-selected-model',
    null,
  );
  const [allowedModels, setAllowedModels] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    getUserModelPreferencesAction()
      .then((prefs) => {
        if (cancelled) return;
        setAllowedModels(prefs.allowedModels ?? []);
      })
      .catch(() => {
        // Non-critical: picker stays disabled on empty list.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const lastWorkflowEventKeyRef = useRef<string | null>(null);
  const personaVersionRef = useRef(0);
  const [shouldResumeStream, setShouldResumeStream] = useState(false);
  const [runtimePollingResumeKey, setRuntimePollingResumeKey] = useState(0);
  const [isDeletingAccessDeniedSession, setIsDeletingAccessDeniedSession] =
    useState(false);
  const [enterToSend, setEnterToSend] = useState(true);

  const { pendingDecisions, handleDecisionResolved } = usePendingDecisions(id);

  useEffect(() => {
    activeRunIdRef.current = activeRunId;
  }, [activeRunId]);

  useEffect(() => {
    setSessionState(session ?? null);
  }, [session]);

  const [sessionModel, setSessionModel] = useState<string | null>(
    session?.model ?? null,
  );
  const [sessionAgent, setSessionAgent] = useState<string | null>(
    typeof session?.metadata?.agent === 'string'
      ? (session.metadata.agent as string)
      : null,
  );
  const selectedModel = session ? sessionModel : draftModel;
  const setSelectedModel = useCallback(
    (model: string | null) => {
      if (session) {
        setSessionModel(model);
        void saveSessionModelAction({ sessionId: id, model }).catch((error) => {
          console.warn('[chat] save session model failed:', error);
          toast.error('Failed to save session model.');
        });
        return;
      }

      setDraftModel(model);
    },
    [id, session, setDraftModel],
  );

  // Persist the persona pick onto session.metadata so it survives reload
  // / regenerate. Mirrors setSelectedModel. In draft (no-session) mode we
  // only hold it in local state; the request body still carries it for the
  // first message, and the server persists it when the session is created.
  const setSelectedAgent = useCallback(
    (agent: string | null) => {
      setSessionAgent(agent);
      if (session) {
        // Bump version so concurrent in-flight saves from prior selections
        // are discarded when they complete — only the latest wins.
        const version = ++personaVersionRef.current;
        void saveSessionPersonaAction({ sessionId: id, agent })
          .then(() => {
            if (personaVersionRef.current !== version) return;
          })
          .catch((error) => {
            if (personaVersionRef.current !== version) return;
            console.warn('[chat] save session persona failed:', error);
            toast.error('Failed to save session persona.');
          });
      }
    },
    [id, session],
  );

  useEffect(() => {
    setSessionModel(session?.model ?? null);
  }, [session?.model]);

  useEffect(() => {
    setSessionAgent(
      typeof session?.metadata?.agent === 'string'
        ? (session.metadata.agent as string)
        : null,
    );
  }, [session?.metadata?.agent]);

  useEffect(() => {
    let cancelled = false;

    getChatUiSettingsAction()
      .then((settings) => {
        if (!cancelled) {
          setEnterToSend(settings.enterToSend);
        }
      })
      .catch((error) => {
        console.warn('[chat] load UI settings failed:', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!bootstrapStatusRunId) {
      return;
    }

    let cancelled = false;

    const fetchBootstrapStatus = async () => {
      try {
        const response = await ofetch.raw<{
          session?: { channel?: string | null };
        }>(`/api/ai/${bootstrapStatusRunId}/status`, {
          cache: 'no-store',
          ignoreResponseError: true,
        });

        if (cancelled) {
          return;
        }

        // A 404 means the workflow run was finalized and its workflowRunId
        // cleared from the session (typical when the model provider returned
        // an error and finalizeRunStep ran). Stop polling — otherwise we'd
        // hammer this endpoint every 1.5s and flood the Vercel logs with
        // "Run not found" 404s. The chat status effect will have already
        // flipped to 'error'/'ready' and cleared activeRunId.
        if (response.status === 404) {
          setBootstrapStatusRunId(null);
          return;
        }

        if (!response.ok) {
          return;
        }

        const payload = response._data ?? {};
        const channel =
          typeof payload.session?.channel === 'string'
            ? payload.session.channel
            : (session?.channel ?? 'web');

        setSessionState((current) =>
          current
            ? {
                ...current,
                channel,
              }
            : {
                id,
                title: null,
                channel,
                externalThreadId: session?.externalThreadId ?? null,
                model: session?.model ?? null,
                accessDenied: session?.accessDenied ?? false,
                readOnlyChannel: session?.readOnlyChannel ?? null,
              },
        );
        invalidateSessionList();
        setBootstrapStatusRunId(null);
      } catch (error) {
        console.warn('[chat] bootstrap status failed:', error);
      }
    };

    void fetchBootstrapStatus();

    const interval = window.setInterval(() => {
      void fetchBootstrapStatus();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    bootstrapStatusRunId,
    id,
    session?.accessDenied,
    session?.channel,
    session?.externalThreadId,
    session?.model,
    session?.readOnlyChannel,
  ]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<WorkflowUIMessage>({
        api: '/api/ai',
        fetch: async (request, init) => {
          const response = await ofetch.native(request, init);
          const runId = response.headers.get('x-workflow-run-id');
          if (runId) {
            activeRunIdRef.current = runId;
            setActiveRunId(runId);
            if (shouldBootstrapSessionStatusRef.current) {
              setBootstrapStatusRunId(runId);
              shouldBootstrapSessionStatusRef.current = false;
            }
          } else if (!response.ok) {
            activeRunIdRef.current = null;
            setActiveRunId(null);
          }

          if (response.status === 403) {
            try {
              const cloned = response.clone();
              const body = (await cloned.json()) as {
                error?: string;
                message?: string;
                sessionChannel?: string;
                currentChannel?: string;
              };
              if (
                body.error === 'cross_channel_readonly' &&
                body.sessionChannel
              ) {
                const sessionChannel = body.sessionChannel;
                setSessionState((current) =>
                  current
                    ? {
                        ...current,
                        readOnlyChannel: {
                          sessionChannel,
                        },
                      }
                    : {
                        id,
                        title: null,
                        channel: sessionChannel,
                        externalThreadId: null,
                        model: session?.model ?? null,
                        accessDenied: false,
                        readOnlyChannel: {
                          sessionChannel,
                        },
                      },
                );
                toast.error(body.message ?? 'Cross-channel access blocked');
              }
            } catch {
              // Body wasn't JSON or didn't match; let upstream handle the error.
            }
          }

          invalidateSessionList();
          return response;
        },
        prepareSendMessagesRequest: buildChatSendRequestBody,
        prepareReconnectToStreamRequest: () => {
          const runId = activeRunIdRef.current;
          return {
            api: runId ? `/api/ai/${runId}/stream` : '/api/ai',
          };
        },
      }),
    [id, session?.model],
  );

  const {
    messages,
    setMessages,
    sendMessage,
    regenerate,
    status,
    stop,
    resumeStream,
    error,
  } = useChat<WorkflowUIMessage>({
    messageMetadataSchema: chatMessageMetadataSchema,
    id,
    messages: initialMessages,
    transport,
    onData: (dataPart) => {
      if (dataPart.type !== 'data-workflow') {
        return;
      }

      if (dataPart.data.kind !== 'status') {
        return;
      }

      if (dataPart.data.type === 'user-message') {
        return;
      }

      // Extract token usage from token-usage and step-finish events
      if (
        dataPart.data.type === 'token-usage' ||
        dataPart.data.type === 'step-finish'
      ) {
        const d = dataPart.data;
        const usage = d.type === 'token-usage' ? d.usage : d;
        const extractNum = (v: unknown): number => {
          if (typeof v === 'number' && Number.isFinite(v)) return v;
          if (
            v &&
            typeof v === 'object' &&
            'total' in v &&
            typeof (v as { total: unknown }).total === 'number'
          )
            return (v as { total: number }).total;
          return 0;
        };
        setTokenUsage({
          input: extractNum(usage.inputTokens),
          output: extractNum(usage.outputTokens),
          total: extractNum(usage.totalTokens),
        });
      }

      const eventKey = JSON.stringify(dataPart.data);
      if (lastWorkflowEventKeyRef.current === eventKey) {
        return;
      }

      lastWorkflowEventKeyRef.current = eventKey;
      setLatestRuntimeEvent(dataPart.data);
    },
    experimental_throttle: 100,
  });

  // PPR hydration: when the page is partially prerendered, the Chat
  // component mounts during the static-shell phase with empty
  // initialMessages. useChat's useRef-held Chat instance latches onto
  // that empty array. Once the dynamic RSC payload arrives with the
  // real messages, inject them into useChat. Only do this while idle
  // (never clobber an active stream) and only once per id (tracked via
  // hydratedMessagesRef, reset when the chat id changes by the Chat
  // component's key prop forcing a full remount).
  useEffect(() => {
    if (initialMessages.length === 0) return;
    if (
      hydratedMessagesRef.current !== null &&
      hydratedMessagesRef.current.length >= initialMessages.length
    ) {
      return;
    }
    if (status === 'streaming' || status === 'submitted') return;
    hydratedMessagesRef.current = initialMessages;
    setMessages(initialMessages);
  }, [initialMessages, setMessages, status]);

  useEffect(() => {
    statusRef.current = status;

    // When the chat leaves a loading state (stream completed, errored out,
    // or was aborted), the workflow run is no longer active. Clearing
    // activeRunId here is the catch-all path that covers streams which
    // return 200 + x-workflow-run-id but then fail mid-flight (e.g. model
    // provider 400). In those cases the transport's `else if (!response.ok)`
    // branch never runs, so without this the composer would stay locked
    // (StopButton instead of SendButton) until a page refresh.
    if (status === 'ready' || status === 'error') {
      activeRunIdRef.current = null;
      setActiveRunId(null);
    }
  }, [status]);

  // === TTS auto-play ===
  // Whether TTS can be used at all on the Web is gated by the admin
  // having configured a speech model. The actual decision to auto-play
  // is the user's (per-user localStorage toggle).
  const { config: appConfig } = useAppConfig();
  const ttsAvailable = Boolean(appConfig?.tts?.model);
  const [ttsAutoplay, setTtsAutoplay] = useState(false);

  useEffect(() => {
    setTtsAutoplay(readTtsAutoplay(Boolean(appConfig?.chat?.tts_autoplay)));
  }, [appConfig?.chat?.tts_autoplay]);

  const [autoPlayMessageId, setAutoPlayMessageId] = useState<string | null>(
    null,
  );

  useTtsAutoplay({
    messages,
    status,
    enabled: ttsAvailable && ttsAutoplay,
    onPlay: (_text, messageId) => {
      // Telling the AudioPlayer for THIS message to auto-play. Any
      // previous autoPlayMessageId is replaced, so concurrent assistant
      // messages never play over each other.
      setAutoPlayMessageId(messageId);
    },
  });

  const requestResumeStream = useCallback(async () => {
    if (!activeRunIdRef.current) {
      return;
    }

    if (resumeInFlightRef.current) {
      return;
    }

    if (
      statusRef.current === 'streaming' ||
      statusRef.current === 'submitted'
    ) {
      return;
    }

    resumeInFlightRef.current = true;

    try {
      await resumeStream();
    } catch (error) {
      console.warn('[chat] resume stream failed:', error);
    } finally {
      resumeInFlightRef.current = false;
    }
  }, [resumeStream]);

  const isLoading = status === 'streaming' || status === 'submitted';
  const isComposerBusy = isLoading || Boolean(activeRunId);

  const stopStreamingReader = useCallback(async () => {
    if (
      statusRef.current !== 'streaming' &&
      statusRef.current !== 'submitted'
    ) {
      return;
    }

    await stop();

    const startedAt = Date.now();
    while (
      statusRef.current === 'streaming' ||
      statusRef.current === 'submitted'
    ) {
      if (Date.now() - startedAt > 1500) {
        break;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
  }, [stop]);

  const sendComposerMessage = useCallback(
    async (message?: ComposerMessage, options?: ChatRequestOptions) => {
      const isStreaming =
        statusRef.current === 'streaming' || statusRef.current === 'submitted';
      const messageText =
        message && 'parts' in message
          ? extractTextFromParts(message.parts)
          : '';
      const isCommandMessage = messageText.startsWith('/');

      if (
        !message ||
        !('parts' in message) ||
        !isStreaming ||
        isCommandMessage
      ) {
        await sendMessage(message, options);
        return;
      }

      const runId = activeRunIdRef.current;
      if (!runId) {
        throw new Error('Active workflow run is not ready yet.');
      }

      const clientMessageId = generateUUID();
      const parts = cloneUIParts(message.parts);
      const previousMessages = cloneMessages(messages);

      await stopStreamingReader();

      setMessages((current) => {
        const nextMessages = [...current];
        if (nextMessages.at(-1)?.role === 'assistant') {
          nextMessages.pop();
        }

        nextMessages.push({
          id: clientMessageId,
          role: 'user',
          parts,
        });

        return nextMessages;
      });

      try {
        const optionsBody = isRecord(options?.body) ? options.body : {};
        await ofetch(`/api/ai/${runId}/message`, {
          method: 'POST',
          body: {
            ...optionsBody,
            type: 'user-message',
            message: extractTextFromParts(parts),
            parts,
            uiMessageId: clientMessageId,
          },
        });

        invalidateSessionList();
        await requestResumeStream();
      } catch (error) {
        setMessages(previousMessages);
        throw error;
      }
    },
    [
      messages,
      requestResumeStream,
      sendMessage,
      setMessages,
      stopStreamingReader,
    ],
  );

  const ensureSessionTitleFromText = useCallback(
    async (text: string, existingMessages: WorkflowUIMessage[]) => {
      if (sessionState?.title) {
        return;
      }

      const hasConversation = existingMessages.some(
        (message) => message.role === 'user' || message.role === 'assistant',
      );
      if (hasConversation) {
        return;
      }

      const title = deriveSessionTitle(text);
      if (!title) {
        return;
      }

      setSessionState((current) =>
        current
          ? {
              ...current,
              title,
            }
          : {
              id,
              title,
              channel: session?.channel ?? 'web',
              externalThreadId: session?.externalThreadId ?? null,
              model: session?.model ?? null,
              accessDenied: false,
              readOnlyChannel: null,
            },
      );
      upsertSessionListItem({
        id,
        title,
        channel: session?.channel ?? 'web',
        createdAt: new Date().toISOString(),
      });

      try {
        await updateSessionTitleAction({ id, title });
        invalidateSessionList();
      } catch (error) {
        console.warn('[chat] update session title failed:', error);
      }
    },
    [
      id,
      session?.channel,
      session?.externalThreadId,
      session?.model,
      sessionState?.title,
    ],
  );

  const submitChatMessage = useCallback(
    async (message?: ComposerMessage, options?: ChatRequestOptions) => {
      const outgoingText =
        message && 'parts' in message
          ? extractTextFromParts(message.parts)
          : '';
      const previousMessages = cloneMessages(messages);
      const isFirstMessage =
        previousMessages.length === 0 &&
        sessionState == null &&
        bootstrapStatusRunId == null;
      const optimisticTitle = deriveSessionTitle(outgoingText);

      if (isFirstMessage) {
        shouldBootstrapSessionStatusRef.current = true;
        setSessionState({
          id,
          title: optimisticTitle,
          channel: session?.channel ?? 'web',
          externalThreadId: session?.externalThreadId ?? null,
          model: session?.model ?? null,
          accessDenied: false,
          readOnlyChannel: null,
        });
        upsertSessionListItem({
          id,
          title: optimisticTitle,
          channel: session?.channel ?? 'web',
          createdAt: new Date().toISOString(),
        });
      }

      try {
        await sendComposerMessage(
          message,
          applySelectedAgentOption(
            applySelectedModelOption(options, selectedModel),
            sessionAgent,
          ),
        );
      } catch (error) {
        if (isFirstMessage) {
          shouldBootstrapSessionStatusRef.current = false;
          setBootstrapStatusRunId(null);
          setSessionState(session ?? null);
          invalidateSessionList();
        }

        throw error;
      }

      setRuntimePollingResumeKey((current) => current + 1);

      if (outgoingText) {
        await ensureSessionTitleFromText(outgoingText, previousMessages);
      }
    },
    [
      bootstrapStatusRunId,
      ensureSessionTitleFromText,
      id,
      messages,
      selectedModel,
      sendComposerMessage,
      session,
      sessionAgent,
      sessionState,
    ],
  );

  const regenerateWithSelectedModel = useCallback(
    async (options?: { messageId?: string } & ChatRequestOptions) => {
      await regenerate(
        applySelectedAgentOption(
          applySelectedModelOption(options, selectedModel),
          sessionAgent,
        ),
      );
    },
    [regenerate, selectedModel, sessionAgent],
  );

  const submitInlineFollowUp = useCallback(
    async (input: {
      messageId: string;
      question: string;
      selectedText: string;
    }) => {
      const text = buildInlineFollowUpText({
        quoteLabel: '选中的内容',
        quoteText: input.selectedText,
        question: input.question,
      });

      await submitChatMessage({
        id: generateUUID(),
        role: 'user',
        parts: [{ type: 'text', text }],
      });
    },
    [submitChatMessage],
  );

  const submitSuggestedFollowUp = useCallback(
    (question: string) => {
      const text = question.trim();
      if (!text) {
        return;
      }

      void submitChatMessage({
        id: generateUUID(),
        role: 'user',
        parts: [{ type: 'text', text }],
      });
    },
    [submitChatMessage],
  );

  const cancelWorkflow = useCallback(async () => {
    stop();

    try {
      await controlSessionRuntimeAction({
        sessionId: id,
        target: 'workflow',
        action: 'cancel',
      });

      activeRunIdRef.current = null;
      setActiveRunId(null);
    } catch (error) {
      console.warn('[chat] cancel workflow failed:', error);
    }

    // Force update status ref to prevent stop button from staying visible
    statusRef.current = 'ready';
  }, [id, stop]);

  const submitToolApproval = useCallback(
    async (input: ToolApprovalInput) => {
      await controlSessionRuntimeAction({
        sessionId: id,
        target: 'approval',
        action: input.action,
        toolCallId: input.toolCallId,
        comment: input.comment,
      });

      setRuntimePollingResumeKey((current) => current + 1);
      setShouldResumeStream(true);
      await requestResumeStream();
    },
    [id, requestResumeStream],
  );

  const handleRuntimeLoaded = useCallback((runtime: SessionRuntimeSnapshot) => {
    const runId = getStreamingRunId(runtime);
    if (runId && runId !== activeRunIdRef.current) {
      activeRunIdRef.current = runId;
      setShouldResumeStream(true);
    }

    if (!runId) {
      activeRunIdRef.current = null;
    }

    setActiveRunId(runId);
  }, []);

  useEffect(() => {
    if (!shouldResumeStream || !activeRunId || isLoading) {
      return;
    }

    setShouldResumeStream(false);
    void requestResumeStream();
  }, [activeRunId, isLoading, requestResumeStream, shouldResumeStream]);

  useStreamRecovery({
    activeRunId,
    isLoading,
    error,
    requestResumeStream,
  });

  // Show error toast when chat encounters an error
  useEffect(() => {
    if (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to send message';
      toast.error(`Chat error: ${errorMessage}`);
      console.error('[chat] error:', error);
    }
  }, [error]);

  const handlePromptSelect = useCallback((prompt: string) => {
    setInput(prompt);
    setComposerFocusKey((current) => current + 1);
  }, []);

  const handleAbort = useCallback(() => {
    setSessionState((prev) =>
      prev ? { ...prev, status: 'aborted' as const } : prev,
    );
  }, []);

  const deleteAccessDeniedSession = useCallback(async () => {
    setIsDeletingAccessDeniedSession(true);

    try {
      await deleteSessionAction(id);
      invalidateSessionList();
      toast.success(t('chat.deleteSuccess'));
      router.push('/');
      router.refresh();
    } catch (error) {
      console.warn('[chat] delete access-denied session failed:', error);
      toast.error(t('chat.deleteError'));
    } finally {
      setIsDeletingAccessDeniedSession(false);
    }
  }, [id, router, t]);

  const handleRevert = useCallback(
    async (messageId: string) => {
      if (!id) return;
      try {
        await ofetch(`/api/sessions/${id}/revert`, {
          method: 'POST',
          body: { message_id: messageId },
        });
        setMessages((current) => {
          const targetIndex = current.findIndex(
            (message) => message.id === messageId,
          );

          if (targetIndex === -1) {
            return current;
          }

          // Include the target message itself (targetIndex + 1)
          return current.slice(0, targetIndex + 1);
        });
        activeRunIdRef.current = null;
        setActiveRunId(null);
        setShouldResumeStream(false);
        invalidateSessionList();
        router.refresh();
        toast.success('Reverted to this message');
      } catch {
        toast.error('Failed to revert');
      }
    },
    [id, router, setMessages],
  );

  const isAccessDeniedSession = sessionState?.accessDenied === true;
  const isReadOnlyChannelSession = Boolean(sessionState?.readOnlyChannel);
  const isRuntimePanelEnabled =
    !isAccessDeniedSession &&
    (Boolean(session) || initialMessages.length > 0 || Boolean(activeRunId));

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Cmd/Ctrl+K → focus input
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        setComposerFocusKey((current) => current + 1);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Build session state with token usage for header
  const headerSession = sessionState
    ? { ...sessionState, tokenUsage: tokenUsage ?? undefined }
    : null;

  return (
    <SidebarProvider>
      <ChatSidebar />
      <MobileDrawerBridge />
      <SidebarInset className="min-w-0 bg-background">
        <div className="flex h-dvh min-h-0 min-w-0 flex-col overflow-hidden bg-background">
          <ChatHeader
            session={headerSession}
            chatId={id}
            onAbort={handleAbort}
          />

          <Messages
            key={id}
            chatId={id}
            isLoading={isLoading}
            messages={messages}
            pendingDecisions={pendingDecisions}
            onPromptSelect={handlePromptSelect}
            onToolApproval={submitToolApproval}
            onRevert={handleRevert}
            onDecisionResolved={handleDecisionResolved}
            onFollowUpSubmit={
              isAccessDeniedSession || isReadOnlyChannelSession
                ? undefined
                : submitInlineFollowUp
            }
            onSuggestedFollowUpSelect={
              isAccessDeniedSession || isReadOnlyChannelSession
                ? undefined
                : submitSuggestedFollowUp
            }
            setMessages={setMessages}
            regenerate={regenerateWithSelectedModel}
            ttsEnabled={ttsAvailable}
            autoPlayMessageId={autoPlayMessageId}
          />

          {isAccessDeniedSession ? (
            <div className="relative z-20 shrink-0 border-t bg-background/95 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] shadow-[0_-12px_30px_rgba(15,23,42,0.06)] backdrop-blur md:pb-6">
              <div className="mx-auto flex w-full flex-col gap-3 md:max-w-4xl md:flex-row md:items-center md:justify-between">
                <p className="text-muted-foreground text-sm">
                  {t('chat.accessDenied.description')}
                </p>
                <Button
                  type="button"
                  variant="destructive"
                  className="gap-2 md:shrink-0"
                  disabled={isDeletingAccessDeniedSession}
                  onClick={() => {
                    void deleteAccessDeniedSession();
                  }}
                >
                  <Trash2 className="size-4" />
                  {t('chat.accessDenied.delete')}
                </Button>
              </div>
            </div>
          ) : isReadOnlyChannelSession ? (
            <div className="relative z-20 shrink-0 border-t bg-background/95 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] shadow-[0_-12px_30px_rgba(15,23,42,0.06)] backdrop-blur md:pb-6">
              <div className="mx-auto flex w-full flex-col gap-3 md:max-w-4xl md:flex-row md:items-center md:justify-between">
                <p className="text-muted-foreground text-sm">
                  {t('chat.crossChannel.description', {
                    sessionChannel:
                      sessionState?.readOnlyChannel?.sessionChannel ??
                      sessionState?.channel ??
                      '',
                  })}
                </p>
                <Button
                  type="button"
                  variant="default"
                  className="gap-2 md:shrink-0"
                  onClick={() => {
                    router.push('/');
                  }}
                >
                  <Plus className="size-4" />
                  {t('chat.crossChannel.newSession')}
                </Button>
              </div>
            </div>
          ) : (
            <form className="relative z-20 shrink-0 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] md:pb-6">
              <div className="mx-auto flex w-full gap-2 md:max-w-4xl">
                <MultimodalInput
                  chatId={id}
                  focusTrigger={composerFocusKey}
                  input={input}
                  setInput={setInput}
                  isLoading={isComposerBusy}
                  enterToSend={enterToSend}
                  stop={() => {
                    void cancelWorkflow();
                  }}
                  sendMessage={submitChatMessage}
                  allowedModels={allowedModels}
                  onSelectModel={setSelectedModel}
                  selectedModel={selectedModel}
                  onSelectAgent={setSelectedAgent}
                  selectedAgent={sessionAgent}
                />
              </div>
            </form>
          )}

          <SessionRuntimePanel
            chatId={id}
            enabled={isRuntimePanelEnabled}
            latestRuntimeEvent={latestRuntimeEvent}
            onRuntimeLoaded={handleRuntimeLoaded}
            onWorkflowCancel={cancelWorkflow}
            resumePollingKey={runtimePollingResumeKey}
          />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
