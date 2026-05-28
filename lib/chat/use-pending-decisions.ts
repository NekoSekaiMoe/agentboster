'use client';

import { isAgentdEnabled } from '@/app/(chat)/actions';
import { ofetch } from 'ofetch';
import { useCallback, useEffect, useState } from 'react';

type PendingDecision = {
  decision_id: string;
  type: 'l2_auth' | 'question';
  task_id: string;
  session_id: string;
  command?: string;
  score?: number;
  reason?: string;
  question?: string;
  prompts?: Array<{
    question: string;
    header?: string;
    options?: string[];
    multiple?: boolean;
  }>;
  options?: string[];
  status: string;
  created_at: string;
  timeout_at: string;
};

export function usePendingDecisions(chatId: string) {
  const [pendingDecisions, setPendingDecisions] = useState<PendingDecision[]>(
    [],
  );
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    isAgentdEnabled().then(setEnabled);
  }, []);

  useEffect(() => {
    if (!chatId || !enabled) return;

    const pollDecisions = async () => {
      try {
        const resp = await ofetch<{
          success: boolean;
          data: PendingDecision[];
        }>('/api/agentd/v1/decisions');
        if (resp.success) {
          setPendingDecisions(
            resp.data.filter(
              (d) => d.status === 'sent' || d.status === 'pending',
            ),
          );
        }
      } catch {
        // silent fail
      }
    };

    pollDecisions();
    const interval = setInterval(pollDecisions, 3000);
    return () => clearInterval(interval);
  }, [chatId, enabled]);

  const handleDecisionResolved = useCallback(
    (decisionId: string, _action: string) => {
      setPendingDecisions((prev) =>
        prev.filter((d) => d.decision_id !== decisionId),
      );
    },
    [],
  );

  return {
    pendingDecisions,
    handleDecisionResolved,
  };
}
