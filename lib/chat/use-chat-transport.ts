'use client';

import { DefaultChatTransport } from 'ai';
import { ofetch } from 'ofetch';
import { useMemo, useRef, useState } from 'react';

import { invalidateSessionListQuery } from '@/hooks/use-session-list';
import { switchFireForgetPostToStream } from '@/lib/chat/fire-forget';
import { buildChatSendRequestBody } from '@/lib/chat/transport-request';
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
          const upstream = await ofetch.native(request, init);
          // Fire-and-forget: if POST returned 202 { runId }, switch to
          // GET /api/ai/[runId]/stream (the SSE source). Returns the SSE
          // response and the runId; transparent to the rest of this wrapper.
          const { response, runId: ffRunId } =
            await switchFireForgetPostToStream(upstream, init);

          const runId = ffRunId ?? response.headers.get('x-workflow-run-id');

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

          invalidateSessionListQuery();
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
