import type { Decision } from '@/lib/core/db/schema';
import { tool } from 'ai';
import { z } from 'zod';
import { defineBuildInTool } from '../define';

const decisionInputSchema = z.object({
  description: z.string().min(1),
  reason: z.string().min(1),
  alternatives: z.array(z.string()).default([]),
});

const taskProgressInputSchema = z.object({
  progress: z.string().min(1).optional(),
  decision: decisionInputSchema.optional(),
  pending_add: z.array(z.string()).default([]).optional(),
  pending_done: z.array(z.string()).default([]).optional(),
  known_issue_add: z.array(z.string()).default([]).optional(),
  known_issue_resolve: z.array(z.string()).default([]).optional(),
});

function removeItems(items: string[], removals: string[]) {
  if (removals.length === 0) {
    return items;
  }

  const removalSet = new Set(removals);
  return items.filter((item) => !removalSet.has(item));
}

async function readTaskSummaryStep(sessionId: string) {
  'use step';

  const { getTaskSummary } = await import('@/lib/core/db/agentd');
  return {
    summary: await getTaskSummary(sessionId),
  };
}

async function updateTaskProgressStep(input: {
  sessionId: string;
  agentName: string;
  value: z.infer<typeof taskProgressInputSchema>;
}) {
  'use step';

  const { randomUUID } = await import('node:crypto');
  const { getTaskSummary, upsertTaskSummary } = await import(
    '@/lib/core/db/agentd'
  );
  const { sessionId, agentName, value } = input;
  const existing = await getTaskSummary(sessionId);
  const decisions: Decision[] = existing?.decisions ?? [];
  const pending = [
    ...removeItems(existing?.pending ?? [], value.pending_done ?? []),
    ...(value.pending_add ?? []),
  ];
  const knownIssues = [
    ...removeItems(
      existing?.knownIssues ?? [],
      value.known_issue_resolve ?? [],
    ),
    ...(value.known_issue_add ?? []),
  ];

  if (value.decision) {
    decisions.push({
      id: `dec_${randomUUID()}`,
      timestamp: new Date().toISOString(),
      description: value.decision.description,
      reason: value.decision.reason,
      alternatives: value.decision.alternatives,
    });
  }

  return await upsertTaskSummary({
    taskId: sessionId,
    agentId: agentName,
    sessionId,
    status: existing?.status ?? 'active',
    progress: value.progress ?? existing?.progress ?? undefined,
    decisions,
    pending,
    knownIssues,
  });
}

export default defineBuildInTool({
  id: 'task_summary',
  description:
    'Read and update the current long-running task summary for progress, decisions, pending items, and known issues.',
  factory: async (_config, { sessionId, agentName }) => ({
    task_summary: tool({
      title: 'Task Summary',
      description:
        'Read the current task summary. Call this at the start of each session for long-running work.',
      inputSchema: z.object({}),
      execute: async () => readTaskSummaryStep(sessionId),
    }),

    task_progress: tool({
      title: 'Task Progress',
      description:
        'Update the current task summary when progress, decisions, pending items, or known issues change.',
      inputSchema: taskProgressInputSchema,
      execute: async (value) =>
        updateTaskProgressStep({ sessionId, agentName, value }),
    }),
  }),
});
