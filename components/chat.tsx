'use client';

import { useChat } from '@ai-sdk/react';
import {
  type ChatRequestOptions,
  type CreateUIMessage,
  DefaultChatTransport,
} from 'ai';
import { ofetch } from 'ofetch';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { ChatHeader } from '@/components/chat-header';
import { SessionRuntimePanel } from '@/components/session-runtime-panel';
import {
  invalidateSessionList,
  upsertSessionListItem,
} from '@/lib/chat/session-events';
import { deriveSessionTitle } from '@/lib/chat/session-title';
import { usePendingDecisions } from '@/lib/chat/use-pending-decisions';
import { useStreamRecovery } from '@/lib/chat/use-stream-recovery';
import { generateUUID } from '@/lib/utils';
import {
  type WorkflowStatusData,
  type WorkflowUIMessage,
  chatMessageMetadataSchema,
} from '@/types/workflow';
import { Messages } from './messages';
import { MultimodalInput } from './multimodal-input';

type SessionRuntimeSnapshot = {
  workflow?: { runId?: string | null; status?: string | null };
};

type SessionMessagesResponse = {
  sessionId: string;
  messages: WorkflowUIMessage[];
  hasMore: boolean;
  nextBefore: string | null;
};

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

function extractLatestUserInput(messages: WorkflowUIMessage[]): {
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

function cloneUIParts(
  parts: WorkflowUIMessage['parts'],
): WorkflowUIMessage['parts'] {
  return JSON.parse(JSON.stringify(parts)) as WorkflowUIMessage['parts'];
}

function cloneMessages(messages: WorkflowUIMessage[]): WorkflowUIMessage[] {
  return JSON.parse(JSON.stringify(messages)) as WorkflowUIMessage[];
}

function extractTextFromParts(parts: WorkflowUIMessage['parts']): string {
  return parts
    .filter(
      (
        part,
      ): part is Extract<
        WorkflowUIMessage['parts'][number],
        { type: 'text' }
      > => part.type === 'text',
    )
    .map((part) => part.text)
    .join('')
    .trim();
}

export function Chat({
  id,
  initialMessages = [],
  session,
}: {
  id: string;
  initialMessages?: WorkflowUIMessage[];
  session?: {
    title: string | null;
    channel: string;
    externalThreadId: string | null;
  } | null;
}) {
  const activeRunIdRef = useRef<string | null>(null);
  const shouldBootstrapSessionStatusRef = useRef(false);
  const resumeInFlightRef = useRef(false);
  const statusRef = useRef<'submitted' | 'streaming' | 'ready' | 'error'>(
    'ready',
  );
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [composerFocusKey, setComposerFocusKey] = useState(0);
  const [sessionState, setSessionState] = useState(session);
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
  const lastWorkflowEventKeyRef = useRef<string | null>(null);
  const [shouldResumeStream, setShouldResumeStream] = useState(false);
  const [runtimePollingResumeKey, setRuntimePollingResumeKey] = useState(0);

  const { pendingDecisions, handleDecisionResolved } = usePendingDecisions(id);

  useEffect(() => {
    activeRunIdRef.current = activeRunId;
  }, [activeRunId]);

  useEffect(() => {
    setSessionState(session);
  }, [session]);

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

        if (!response.ok || cancelled) {
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
                title: null,
                channel,
                externalThreadId: session?.externalThreadId ?? null,
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
  }, [bootstrapStatusRunId, session?.channel, session?.externalThreadId]);

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

          invalidateSessionList();
          return response;
        },
        prepareSendMessagesRequest: ({
          id: chatId,
          messages,
          trigger,
          messageId,
          body,
        }) => {
          const bodyRecord = isRecord(body) ? body : {};
          const bodyInput = isRecord(bodyRecord.input)
            ? bodyRecord.input
            : null;
          const editedParts = Array.isArray(bodyInput?.parts)
            ? (bodyInput.parts as WorkflowUIMessage['parts'])
            : null;

          const targetMessage =
            (messageId
              ? messages.find((message) => message.id === messageId)
              : undefined) ?? messages.at(-1);
          const targetParts =
            editedParts ??
            (targetMessage?.role === 'user'
              ? cloneUIParts(targetMessage.parts)
              : []);

          return {
            body: {
              id: chatId,
              trigger,
              messageId,
              input: {
                parts: targetParts,
                text: extractTextFromParts(targetParts),
              },
            },
          };
        },
        prepareReconnectToStreamRequest: () => {
          const runId = activeRunIdRef.current;
          return {
            api: runId ? `/api/ai/${runId}/stream` : '/api/ai',
          };
        },
      }),
    [],
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
        const d = dataPart.data as any;
        const usage = d.usage ?? d;
        const extractNum = (v: unknown): number => {
          if (typeof v === 'number' && Number.isFinite(v)) return v;
          if (
            v &&
            typeof v === 'object' &&
            typeof (v as any).total === 'number'
          )
            return (v as any).total;
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

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

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
        await ofetch(`/api/ai/${runId}/message`, {
          method: 'POST',
          body: {
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
              title,
              channel: session?.channel ?? 'web',
              externalThreadId: session?.externalThreadId ?? null,
            },
      );
      upsertSessionListItem({
        id,
        title,
        channel: session?.channel ?? 'web',
        createdAt: new Date().toISOString(),
      });

      try {
        await ofetch('/api/sessions/update', {
          method: 'PATCH',
          body: {
            id,
            title,
          },
        });
        invalidateSessionList();
      } catch (error) {
        console.warn('[chat] update session title failed:', error);
      }
    },
    [id, session?.channel, session?.externalThreadId, sessionState?.title],
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
          title: optimisticTitle,
          channel: session?.channel ?? 'web',
          externalThreadId: session?.externalThreadId ?? null,
        });
        upsertSessionListItem({
          id,
          title: optimisticTitle,
          channel: session?.channel ?? 'web',
          createdAt: new Date().toISOString(),
        });
      }

      try {
        await sendComposerMessage(message, options);
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
      sendComposerMessage,
      session,
      sessionState,
    ],
  );

  const cancelWorkflow = useCallback(async () => {
    stop();

    try {
      await ofetch(`/api/sessions/${id}/runtime/control`, {
        method: 'POST',
        body: {
          target: 'workflow',
          action: 'cancel',
        },
      });

      activeRunIdRef.current = null;
      setActiveRunId(null);
    } catch (error) {
      console.warn('[chat] cancel workflow failed:', error);
    }
  }, [id, stop]);

  const submitToolApproval = useCallback(
    async (input: ToolApprovalInput) => {
      const response = await ofetch.raw<{ error?: string }>(
        `/api/sessions/${id}/runtime/control`,
        {
          method: 'POST',
          body: {
            target: 'approval',
            action: input.action,
            toolCallId: input.toolCallId,
            comment: input.comment,
          },
          ignoreResponseError: true,
        },
      );

      if (!response.ok) {
        const payload = response._data ?? {};
        throw new Error(payload.error ?? 'Failed to submit approval.');
      }

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

  const handlePromptSelect = useCallback((prompt: string) => {
    setInput(prompt);
    setComposerFocusKey((current) => current + 1);
  }, []);

  const handleAbort = useCallback(() => {
    setSessionState((prev) =>
      prev ? { ...prev, status: 'aborted' as const } : prev,
    );
  }, []);

  const handleRevert = useCallback(
    async (messageId: string) => {
      if (!id) return;
      try {
        await ofetch(`/api/sessions/${id}/revert`, {
          method: 'POST',
          body: { message_id: messageId },
        });
        toast.success('Reverted to this message');
      } catch {
        toast.error('Failed to revert');
      }
    },
    [id],
  );

  const isRuntimePanelEnabled =
    Boolean(session) || initialMessages.length > 0 || Boolean(activeRunId);

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
    <div className="flex h-dvh min-w-0 flex-col overflow-x-hidden bg-background">
      <ChatHeader session={headerSession} chatId={id} onAbort={handleAbort} />

      <Messages
        chatId={id}
        isLoading={isLoading}
        messages={messages}
        pendingDecisions={pendingDecisions}
        onPromptSelect={handlePromptSelect}
        onToolApproval={submitToolApproval}
        onRevert={handleRevert}
        onDecisionResolved={handleDecisionResolved}
        setMessages={setMessages}
        regenerate={regenerate}
      />

      <form className="flex mx-auto px-4 bg-background pb-4 md:pb-6 gap-2 w-full md:max-w-3xl">
        <MultimodalInput
          chatId={id}
          focusTrigger={composerFocusKey}
          input={input}
          setInput={setInput}
          isLoading={isLoading}
          stop={() => {
            void cancelWorkflow();
          }}
          sendMessage={submitChatMessage}
        />
      </form>

      <SessionRuntimePanel
        chatId={id}
        enabled={isRuntimePanelEnabled}
        latestRuntimeEvent={latestRuntimeEvent}
        onRuntimeLoaded={handleRuntimeLoaded}
        onWorkflowCancel={cancelWorkflow}
        resumePollingKey={runtimePollingResumeKey}
      />
    </div>
  );
}
