'use client';

import { useState } from 'react';

import type { WorkflowStatusData } from '@/types/workflow';

type TokenUsage = {
  input: number;
  output: number;
  total: number;
};

export function useTokenUsage() {
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [latestRuntimeEvent, setLatestRuntimeEvent] =
    useState<WorkflowStatusData | null>(null);

  const handleWorkflowData = (dataPart: {
    type: string;
    data: WorkflowStatusData;
  }) => {
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
        if (v && typeof v === 'object' && typeof (v as any).total === 'number')
          return (v as any).total;
        return 0;
      };
      setTokenUsage({
        input: extractNum(usage.inputTokens),
        output: extractNum(usage.outputTokens),
        total: extractNum(usage.totalTokens),
      });
    }

    setLatestRuntimeEvent(dataPart.data);
  };

  return {
    tokenUsage,
    latestRuntimeEvent,
    handleWorkflowData,
  };
}
