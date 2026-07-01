import { tool } from 'ai';
import { z } from 'zod';
import { defineBuildInTool } from '../define';

/**
 * Sequential-thinking tool.
 *
 * Background: agentboster's Web workflow never sends `reasoning_effort` /
 * `thinking` to any provider (see resolve-model.ts), and the model catalog
 * carries no reasoning capability flag. As a result every model — including
 * reasoning-capable ones (Claude w/ extended thinking, GPT-5, DeepSeek-R1) —
 * is effectively used in non-thinking mode. The CLI `/effort` command
 * persists a preference but never reaches the provider request body.
 *
 * This tool fills that gap with a model-visible, side-effect-free reasoning
 * scratchpad. It mirrors the widely-adopted MCP "sequential-thinking" protocol
 * (thought / thoughtNumber / totalThoughts / nextThoughtNeeded + revision /
 * branch fields): the model emits one thought per tool call, the execute()
 * body simply echoes the thought back as the tool result, and the model
 * continues reasoning in the next turn. The schema explicitly exposes
 * `isRevision` / `revisesThought` / `branchFromThought` / `needsMoreThoughts`
 * so the model can self-correct and branch without consuming context for
 * hidden scratchpads.
 *
 * Why a tool and not just a prompt nudge? A prompt nudge ("think step by
 * step") is unreliable: the model often ignores it on short turns and the
 * reasoning is interleaved with the answer, offering no self-revision handle.
 * A tool call is an explicit, observable act — the agent loop records it,
 * the model commits to a numbered thought, and the nextThoughtNeeded flag
 * forces a conscious decision about whether reasoning is complete.
 *
 * The execute body deliberately performs no IO. It only formats the thought
 * so the model sees its own previous reasoning when continuing. This keeps
 * the tool provider-agnostic (works on every model, even ones without native
 * thinking) and free of persistence concerns.
 */

const sequentialThinkingSchema = z.object({
  thought: z
    .string()
    .min(1)
    .describe(
      'Your current reasoning step. Capture one discrete chunk of thinking ' +
        '— an observation, a hypothesis, a sub-conclusion, or a self-correction.',
    ),
  nextThoughtNeeded: z
    .boolean()
    .describe(
      'True if more reasoning is required before acting. Set false once you ' +
        'have reached a conclusion or a confident next action.',
    ),
  thoughtNumber: z
    .number()
    .int()
    .min(1)
    .describe('The index of this thought in the sequence (1-based).'),
  totalThoughts: z
    .number()
    .int()
    .min(1)
    .describe(
      'Current estimate of the total number of thoughts needed. Update as ' +
        'you learn more — this is advisory, not enforced.',
    ),
  isRevision: z
    .boolean()
    .optional()
    .describe(
      'True if this thought revises a previous one. Pair with ' +
        '`revisesThought` to indicate which.',
    ),
  revisesThought: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'The thoughtNumber being revised. Required when `isRevision` is true.',
    ),
  branchFromThought: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'If this thought branches from another (exploring an alternative ' +
        'path), the thoughtNumber it branches from.',
    ),
  needsMoreThoughts: z
    .boolean()
    .optional()
    .describe(
      'True if the initial `totalThoughts` estimate turns out to be too ' +
        'small and more steps are required.',
    ),
});

type SequentialThought = z.infer<typeof sequentialThinkingSchema>;

function formatThoughtEcho(input: SequentialThought): string {
  const revisionMarker =
    input.isRevision && input.revisesThought
      ? ` (revises thought ${input.revisesThought})`
      : '';
  const branchMarker =
    input.branchFromThought !== undefined
      ? ` (branches from thought ${input.branchFromThought})`
      : '';
  const moreMarker = input.needsMoreThoughts ? ' [needs more thoughts]' : '';
  const progress =
    input.thoughtNumber >= input.totalThoughts
      ? `${input.thoughtNumber}/${input.totalThoughts}`
      : `${input.thoughtNumber}/${input.totalThoughts}+`;
  return (
    `Thought ${progress}${revisionMarker}${branchMarker}${moreMarker}:\n` +
    input.thought
  );
}

export default defineBuildInTool({
  id: 'sequential_thinking',
  description:
    'A side-effect-free reasoning scratchpad for non-thinking models. ' +
    'Emit one numbered thought per call; the thought is echoed back as the ' +
    'tool result so you can build on it in subsequent turns. Use for ' +
    'multi-step analysis, hypothesis testing, self-revision, or branching ' +
    'exploration before committing to an action. The model decides when ' +
    'reasoning is complete via `nextThoughtNeeded`.',
  factory: async () => {
    return {
      sequential_thinking: tool({
        title: 'Sequential Thinking',
        description:
          'Reason through a complex problem one step at a time. Each call ' +
          'records a single thought and returns it so you can iterate. Set ' +
          'nextThoughtNeeded=false when you have reached a conclusion or ' +
          'are ready to act. Use isRevision/revisesThought to correct ' +
          'earlier mistakes, branchFromThought to explore alternatives.',
        inputSchema: sequentialThinkingSchema,
        execute: async (input) => {
          return {
            ok: true,
            echo: formatThoughtEcho(input),
            thoughtNumber: input.thoughtNumber,
            totalThoughts: input.totalThoughts,
            nextThoughtNeeded: input.nextThoughtNeeded,
          };
        },
      }),
    };
  },
});
