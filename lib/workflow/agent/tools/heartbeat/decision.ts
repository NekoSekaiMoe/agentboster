/**
 * heartbeat_decision — proactive-speak gate for heartbeat runs.
 *
 * Note: 设计与切片状态见 .agents/notes/proposed/feature/2026-09-13-session-heartbeat.md
 *
 * Ported pattern: arkloop's LLM Heartbeat (ref/arkloop
 * src/services/worker/internal/tools/builtin/heartbeat_decision +
 * mw_llm_heartbeat.go). A heartbeat run wakes the agent on a session-owned
 * interval and asks exactly one question first: should the agent proactively
 * speak in this thread, or stay silent?
 *
 * Contract:
 * - Registered for EVERY agent run (built-in, always enabled) so the tool
 *   schema is identical between heartbeat and normal runs. Providers key
 *   prompt caches on the tool schema; a per-run-kind schema drift would
 *   invalidate the cache in both directions (arkloop keeps
 *   tool_schema_hash stable for the same reason).
 * - In a heartbeat run the agent loop forces toolChoice to this tool for
 *   step 0 (prepareStep in lib/workflow/agent/index.ts). reply=false stops
 *   the run and withholds all output; reply=true lets the loop continue —
 *   the model may then use read tools to gather context before composing
 *   the message it actually sends.
 * - Outside heartbeat runs the executor fails closed (arkloop semantics:
 *   "heartbeat_decision called outside heartbeat run"): the decision is
 *   meaningless without the heartbeat contract, and a stray call must not
 *   acknowledge as if it succeeded.
 * - The agent loop reads the decision from the step's tool-call input — a
 *   single source of truth, no side-channel map to leak between runs.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { defineBuildInTool, type BuildInToolFactoryContext } from '../define';

export const HEARTBEAT_DECISION_TOOL_NAME = 'heartbeat_decision';

export default defineBuildInTool({
  id: 'heartbeat',
  description:
    'Decide whether the agent should proactively message the thread ' +
    'during a scheduled heartbeat wake-up. Only meaningful in heartbeat ' +
    'runs; normal runs must answer the user directly instead.',
  factory: async (
    _config: Record<string, string>,
    context: BuildInToolFactoryContext,
  ) => {
    const heartbeatRun = context.heartbeat === true;
    return {
      [HEARTBEAT_DECISION_TOOL_NAME]: tool({
        title: 'Heartbeat speak decision',
        description:
          'Called first in every heartbeat run. Decide whether to send a ' +
          'proactive message to this thread now, or stay silent until the ' +
          'next cycle.',
        inputSchema: z.object({
          reply: z
            .boolean()
            .describe(
              'true → compose and send a proactive message to the thread ' +
                'this cycle; false → stay silent (nothing is sent).',
            ),
          reason: z
            .string()
            .max(500)
            .optional()
            .describe(
              'One short sentence explaining the decision (logged for ' +
                'debugging, never shown to the user).',
            ),
        }),
        execute: async (input) => {
          if (!heartbeatRun) {
            return {
              ok: false,
              error:
                'heartbeat_decision is only available in heartbeat runs; ' +
                'ignore it and answer the user normally.',
            };
          }
          return {
            ok: true,
            reply: input.reply,
            reason: input.reason ?? null,
          };
        },
      }),
    };
  },
});
