/**
 * advisor — a built-in extension that lets the agent escalate to a stronger
 * reviewer model mid-task.
 *
 * Ported from @juicesharp/rpiv-advisor, adapted for the agentboster thin
 * client. The upstream extension calls pi-ai's completeSimple(); in this fork
 * that throws (all normal turns route through the web backend, which owns
 * model choice and only forwards the latest user turn). So the advisor makes a
 * direct one-shot provider call over fetch() using its own persisted key
 * material — see execute.ts.
 *
 * Registers:
 *   - the `advisor` tool (zero params — full context is forwarded automatically)
 *   - the `/advisor` command (pick model + effort + key)
 *   - a session_start handler that seeds in-memory state from advisor.json
 */

import { Type } from 'typebox';
import type { ExtensionAPI } from '../../core/extensions/index.ts';
import { registerAdvisorCommand } from './command.ts';
import { loadAdvisorConfig } from './config.ts';
import {
  ADVISOR_PROMPT_GUIDELINES,
  ADVISOR_PROMPT_SNIPPET,
  ADVISOR_TOOL_LABEL,
  ADVISOR_TOOL_NAME,
} from './constants.ts';
import { type AdvisorDetails, executeAdvisor } from './execute.ts';
import { applyAdvisorConfig, getAdvisorState } from './state.ts';

const ADVISOR_DESCRIPTION =
  'Escalate to a stronger reviewer model for guidance. When you need ' +
  'stronger judgment — a complex decision, an ambiguous failure, a problem ' +
  "you're circling without progress — escalate to the advisor model for " +
  'guidance, then resume. Takes NO parameters — when you call advisor(), ' +
  'your entire conversation history is automatically forwarded. The advisor ' +
  'sees the task, every tool call you have made, and every result you have seen.';

const AdvisorParams = Type.Object({});

export default function advisor(pi: ExtensionAPI): void {
  registerAdvisorCommand(pi);

  pi.registerTool<typeof AdvisorParams, AdvisorDetails>({
    name: ADVISOR_TOOL_NAME,
    label: ADVISOR_TOOL_LABEL,
    description: ADVISOR_DESCRIPTION,
    promptSnippet: ADVISOR_PROMPT_SNIPPET,
    promptGuidelines: ADVISOR_PROMPT_GUIDELINES,
    parameters: AdvisorParams,
    async execute(_toolCallId, _params, signal, onUpdate, ctx) {
      const s = getAdvisorState();
      return executeAdvisor(
        ctx,
        {
          provider: s.provider,
          modelId: s.modelId,
          api: s.api,
          baseUrl: s.baseUrl,
          effort: s.effort,
          apiKey: s.apiKey,
        },
        signal,
        onUpdate,
      );
    },
  });

  // Seed in-memory state from disk on every session start (startup, resume,
  // new, fork, reload) so the tool and command see the persisted model choice.
  pi.on('session_start', async () => {
    const config = loadAdvisorConfig();
    applyAdvisorConfig(config);
  });
}
