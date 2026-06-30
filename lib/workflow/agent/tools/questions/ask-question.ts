import { getDecisionQueue, type Decision } from '@/lib/security/l2-index';
import { DecisionStatus, DecisionType } from '@/lib/security/l2-decision-queue';
import { tool } from 'ai';
import { z } from 'zod';
import { defineBuildInTool } from '../define';

const promptSchema = z.object({
  question: z.string().min(1),
  header: z.string().optional(),
  options: z.array(z.string()).optional(),
  multiple: z.boolean().optional(),
});

const askQuestionSchema = z.object({
  prompts: z.array(promptSchema).min(1).max(5),
});

export default defineBuildInTool({
  id: 'ask_question',
  description:
    'Ask the user one or more clarifying questions during execution. ' +
    'Blocks until the user answers (up to the timeout). Use sparingly — ' +
    'prefer acting on reasonable assumptions over interrupting the user. ' +
    'Each prompt can be free-text (no options) or multiple-choice.',
  factory: async (_config, { sessionId, agentName, runId }) => {
    return {
      ask_question: tool({
        title: 'Ask Question',
        description:
          'Ask the user a clarifying question. The workflow step pauses ' +
          'until the user answers or the question times out.',
        inputSchema: askQuestionSchema,
        execute: async (value) => {
          const queue = getDecisionQueue();
          const decisionId = `q_${runId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const timeoutMs = 5 * 60 * 1000; // 5 minutes

          await queue.enqueue({
            decisionId,
            type: DecisionType.QUESTION,
            taskId: runId,
            sessionId,
            agentId: agentName,
            status: DecisionStatus.PENDING,
            question: value.prompts[0]?.question ?? '',
            prompts: value.prompts,
            createdAt: new Date(),
            timeoutAt: new Date(Date.now() + timeoutMs),
          } as unknown as Decision);

          const resolved = await queue.waitForResolution(decisionId, timeoutMs);

          if (!resolved) {
            return {
              ok: false,
              error: 'Question timed out with no answer.',
            };
          }

          if (resolved.status === DecisionStatus.DENIED) {
            return {
              ok: false,
              error: 'User dismissed the question.',
            };
          }

          const answers = resolved.answers ?? [];
          if (answers.length === 0) {
            return { ok: true, answer: '(no answer provided)' };
          }

          // Format answers for the model. Each prompt's answer is joined.
          const formatted = value.prompts.map((prompt, i) => {
            const answer = answers[i];
            if (Array.isArray(answer)) {
              return `${prompt.question}: ${(answer as string[]).join(', ')}`;
            }
            return `${prompt.question}: ${String(answer ?? '(no answer)')}`;
          });

          return {
            ok: true,
            answers: formatted,
          };
        },
      }),
    };
  },
});
