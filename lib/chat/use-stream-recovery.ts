'use client';

import { useEffect } from 'react';

type StreamRecoveryOptions = {
  activeRunId: string | null;
  isLoading: boolean;
  error?: Error;
  requestResumeStream: () => Promise<void>;
};

export function useStreamRecovery(options: StreamRecoveryOptions) {
  const { activeRunId, isLoading, error, requestResumeStream } = options;

  // Retry on network errors
  useEffect(() => {
    if (!activeRunId || !error || isLoading) {
      return;
    }

    const message = error.message.toLowerCase();
    if (!message.includes('fetch') && !message.includes('network')) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void requestResumeStream();
    }, 1500);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [activeRunId, error, isLoading, requestResumeStream]);

  // Reconnect on visibility change and online event
  useEffect(() => {
    if (!activeRunId || isLoading) {
      return;
    }

    const reconnect = () => {
      if (document.visibilityState === 'visible') {
        void requestResumeStream();
      }
    };

    const reconnectOnOnline = () => {
      void requestResumeStream();
    };

    window.addEventListener('online', reconnectOnOnline);
    document.addEventListener('visibilitychange', reconnect);

    return () => {
      window.removeEventListener('online', reconnectOnOnline);
      document.removeEventListener('visibilitychange', reconnect);
    };
  }, [activeRunId, isLoading, requestResumeStream]);
}
