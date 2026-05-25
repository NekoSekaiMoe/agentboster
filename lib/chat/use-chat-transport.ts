'use client';

import { DefaultChatTransport } from 'ai';
import { ofetch } from 'ofetch';
import { useMemo, useRef, useState } from 'react';

import { invalidateSessionList } from '@/lib/chat/session-events';
import type { WorkflowUIMessage } from '@/types/workflow';

type TransportOptions = {
  onRunIdChange?: (runId: string | null) => void;
  onBootstrapNeeded?: (runId: string) => void;
};

export function useChatTransport(options: TransportOptions = {}) {
  const { onRunIdChange, onBootstrapNeeded } = options;
  const activeRunIdRef = useRef<string | null>(null);
  const shouldBootstrapRef = useRef(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

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
            onRunIdChange?.(runId);

            if (shouldBootstrapRef.current) {
              onBootstrapNeeded?.(runId);
              shouldBootstrapRef.current = false;
            }
          } else if (!response.ok) {
            activeRunIdRef.current = null;
            setActiveRunId(null);
            onRunIdChange?.(null);
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
          const bodyRecord: Record<string, unknown> =
            typeof body === 'object' && body !== null
              ? (body as Record<string, unknown>)
              : {};
          const rawInput = bodyRecord.input;
          const bodyInput: Record<string, unknown> | null =
            typeof rawInput === 'object' && rawInput !== null
              ? (rawInput as Record<string, unknown>)
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
              ? JSON.parse(JSON.stringify(targetMessage.parts))
              : []);

          return {
            body: {
              id: chatId,
              trigger,
              messageId,
              input: {
                parts: targetParts,
                text: targetParts
                  .filter(
                    (
                      part: WorkflowUIMessage['parts'][number],
                    ): part is Extract<
                      WorkflowUIMessage['parts'][number],
                      { type: 'text' }
                    > => part.type === 'text',
                  )
                  .map(
                    (
                      part: Extract<
                        WorkflowUIMessage['parts'][number],
                        { type: 'text' }
                      >,
                    ) => part.text,
                  )
                  .join('')
                  .trim(),
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
    [onRunIdChange, onBootstrapNeeded],
  );

  const setBootstrapNeeded = (needed: boolean) => {
    shouldBootstrapRef.current = needed;
  };

  const clearActiveRunId = () => {
    activeRunIdRef.current = null;
    setActiveRunId(null);
    onRunIdChange?.(null);
  };

  return {
    transport,
    activeRunId,
    activeRunIdRef,
    setBootstrapNeeded,
    clearActiveRunId,
  };
}
