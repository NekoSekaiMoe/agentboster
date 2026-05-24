'use client';

import { ofetch } from 'ofetch';
import { useEffect, useState } from 'react';

import { invalidateSessionList } from '@/lib/chat/session-events';

type SessionState = {
  title: string | null;
  channel: string;
  externalThreadId: string | null;
};

type BootstrapOptions = {
  runId: string | null;
  initialSession?: SessionState | null;
};

export function useSessionBootstrap(options: BootstrapOptions) {
  const { runId, initialSession } = options;
  const [sessionState, setSessionState] = useState<SessionState | null>(
    initialSession ?? null,
  );

  useEffect(() => {
    if (!runId) {
      return;
    }

    let cancelled = false;

    const fetchBootstrapStatus = async () => {
      try {
        const response = await ofetch.raw<{
          session?: { channel?: string | null };
        }>(`/api/ai/${runId}/status`, {
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
            : (initialSession?.channel ?? 'web');

        setSessionState((current) =>
          current
            ? {
                ...current,
                channel,
              }
            : {
                title: null,
                channel,
                externalThreadId: initialSession?.externalThreadId ?? null,
              },
        );
        invalidateSessionList();
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
  }, [runId, initialSession?.channel, initialSession?.externalThreadId]);

  useEffect(() => {
    setSessionState(initialSession ?? null);
  }, [initialSession]);

  return {
    sessionState,
    setSessionState,
  };
}
