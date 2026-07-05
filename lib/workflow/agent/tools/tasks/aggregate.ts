import { generateText, tool } from 'ai';
import { z } from 'zod';
import { defineBuildInTool } from '../define';
import {
  createModelResolver,
  resolveAgentProviderOptions,
} from '@/lib/workflow/agent/steps/resolve-model';
import { getAgentModelId } from '@/lib/workflow/agent/utils/agent-config';

type AggregateStyle =
  | 'concise_summary'
  | 'structured_json'
  | 'comparison_table'
  | 'custom';

const aggregateSchema = z.object({
  batchId: z
    .string()
    .min(1)
    .describe(
      'The sub-agent batch id whose summaries should be aggregated. Use the ' +
        'same id returned by a previous subAgent spawn/run call.',
    ),
  style: z
    .enum(['concise_summary', 'structured_json', 'comparison_table', 'custom'])
    .default('concise_summary')
    .describe(
      '`concise_summary` = a 3-5 sentence synthesis (default). ' +
        '`structured_json` = a typed object with per-agent fields. ' +
        '`comparison_table` = markdown table comparing agent outputs. ' +
        '`custom` = use the provided customPrompt verbatim as the synthesis instruction.',
    ),
  customPrompt: z
    .string()
    .optional()
    .describe(
      'Required when style=`custom`. Free-form instruction that wraps the summaries ' +
        '(e.g. "Pick the best 2 ideas and explain why.").',
    ),
  maxOutputTokens: z
    .number()
    .int()
    .positive()
    .max(8192)
    .default(1024)
    .describe('Cap on the synthesis length. Default 1024 tokens.'),
});

const STYLE_INSTRUCTIONS: Record<Exclude<AggregateStyle, 'custom'>, string> = {
  concise_summary:
    'Write a 3-5 sentence synthesis that captures the consensus findings, ' +
    'flags any disagreement between agents, and highlights the strongest ' +
    'work product. Do NOT enumerate each agent verbatim.',
  structured_json:
    'Return a single JSON object (no surrounding prose, no markdown fences) ' +
    'shaped as: { "synthesis": string, "perAgent": [{ "agent": string, "task": ' +
    'string, "keyFindings": string[], "quality": "high"|"medium"|"low" }], ' +
    '"disagreements": string[] }. JSON only.',
  comparison_table:
    'Return a markdown table with one row per agent. Columns: Agent | Task | ' +
    'Key Finding | Confidence (high/medium/low). Follow the table with a 1-2 ' +
    'sentence synthesis under a "## Synthesis" heading.',
};

export default defineBuildInTool({
  id: 'aggregate',
  description:
    'Aggregate the summaries of a previously-spawned sub-agent batch into a ' +
    'single synthesis using a separate LLM call. Lets the main agent re-cut ' +
    'the same batch from different angles without re-running the sub-agents. ' +
    'Reads from sessions.metadata.workflowSubagents (same place subAgent persists).',
  factory: async (_config, context) => {
    return {
      aggregate: tool({
        title: 'Aggregate Sub-Agent Results',
        description:
          'Run a one-shot LLM synthesis over the summaries of a sub-agent batch. ' +
          'Useful when subAgent returned a raw batch and you want a concise ' +
          'synthesis, structured JSON, or a comparison table. The batch must ' +
          'have already been collected via subAgent (collect or sync batch).',
        inputSchema: aggregateSchema,
        execute: async (input) => {
          if (input.style === 'custom' && !input.customPrompt) {
            return {
              ok: false,
              error:
                'customPrompt is required when style="custom". Provide a free-form synthesis instruction.',
            };
          }

          // Read the batch state via the same persisted path subAgent uses.
          // This keeps aggregate_results decoupled from subAgent's in-process
          // runtime cache — if the workflow restarted between spawn and
          // aggregate, the DB-persisted state is what we read.
          const { getSession } = await import('@/lib/core/db/chat');
          const session = await getSession(context.sessionId);
          if (!session) {
            return { ok: false, error: 'Session not found.' };
          }
          const meta = (session.metadata ?? {}) as Record<string, unknown>;
          const persisted = (meta.workflowSubagents ?? {}) as {
            batches?: Record<string, unknown>;
            jobs?: Record<string, unknown>;
          };
          const batch = persisted.batches?.[input.batchId] as
            | {
                jobs?: string[];
                status?: string;
                succeeded?: number;
                failed?: number;
              }
            | undefined;
          if (!batch) {
            return {
              ok: false,
              error: `Batch ${input.batchId} not found in session metadata. Spawn it first via subAgent (action: spawn).`,
            };
          }

          const jobs = (persisted.jobs ?? {}) as Record<
            string,
            {
              agentName?: string;
              task?: string;
              status?: string;
              summary?: string;
              error?: string;
              modelId?: string;
            }
          >;
          const jobIds = batch.jobs ?? [];
          if (jobIds.length === 0) {
            return {
              ok: true,
              batchId: input.batchId,
              style: input.style,
              count: 0,
              synthesis: '',
              note: 'Batch has no jobs.',
            };
          }

          const inputs = jobIds.map((id) => {
            const j = jobs[id] ?? {};
            return {
              agentName: j.agentName ?? 'unknown',
              task: j.task ?? '',
              status: j.status ?? 'unknown',
              summary: j.summary ?? j.error ?? '',
              modelId: j.modelId,
            };
          });

          const styleInstruction =
            input.style === 'custom'
              ? (input.customPrompt as string)
              : STYLE_INSTRUCTIONS[
                  input.style as Exclude<AggregateStyle, 'custom'>
                ];

          const rendered = inputs
            .map((j, idx) => {
              return [
                `## Participant ${idx + 1}: ${j.agentName}`,
                `Task: ${j.task}`,
                `Status: ${j.status}`,
                `Model: ${j.modelId ?? 'n/a'}`,
                'Output:',
                j.summary || '(no output)',
              ].join('\n');
            })
            .join('\n\n---\n\n');

          const prompt = [
            'You are aggregating the outputs of N parallel sub-agents that worked on related tasks.',
            'Your job is to synthesize their work according to the STYLE instruction below.',
            '',
            `STYLE: ${styleInstruction}`,
            '',
            'Be faithful to the source material — do not invent findings the agents did not report.',
            'If a sub-agent failed (status != "completed"), surface that in your synthesis.',
            '',
            '--- PARTICIPANT OUTPUTS ---',
            rendered,
          ].join('\n');

          // Resolve the parent agent's model — keeps the synthesis aligned
          // with the main agent's quality tier rather than always using a
          // cheap model (which would distort comparison styles).
          const modelId = getAgentModelId(context.appConfig, context.agentName);
          const providerOptions = await resolveAgentProviderOptions(
            context.appConfig,
            modelId,
          );

          const result = await generateText({
            model: await createModelResolver(context.appConfig, modelId)(),
            prompt,
            maxOutputTokens: input.maxOutputTokens,
            providerOptions,
          });

          return {
            ok: true,
            batchId: input.batchId,
            style: input.style,
            count: inputs.length,
            succeeded:
              batch.succeeded ??
              inputs.filter((x) => x.status === 'completed').length,
            failed:
              batch.failed ??
              inputs.filter((x) => x.status === 'failed').length,
            synthesis: result.text,
            usage: result.usage,
          };
        },
      }),
    };
  },
});
