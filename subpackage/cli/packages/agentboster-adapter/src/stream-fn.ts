/**
 * Wrap the web stream as a pi `StreamFn`.
 *
 * Returns a function that satisfies `@earendil-works/pi-agent`'s StreamFn
 * contract — pi's agent loop calls it with (model, context, options) and
 * expects an `AssistantMessageEventStream` back.
 *
 * The implementation ignores the local model selection (the web backend
 * owns model choice) and forwards only the latest user message to the
 * server, since the server maintains full conversation history.
 */

import type { StreamFn } from '@agentboster-cli/agent';
import { createAssistantMessageEventStream } from '@agentboster-cli/ai/utils/event-stream';
import type {
  Api,
  Context,
  Model,
  SimpleStreamOptions,
} from '@agentboster-cli/ai';

import {
  openAgentbosterStream,
  type SubagentBatchEventHandler,
  type SubagentEventHandler,
  type WebStreamOptions,
} from './web-stream.ts';

export interface CreateStreamFnOptions
  extends Omit<WebStreamOptions, 'baseUrl' | 'token' | 'sessionId'> {
  /** Resolve the current session id (called each turn so the host can rotate). */
  getSessionId: () => string;
  /** Resolve the current server URL + token (called each turn). */
  getAuth: () => { baseUrl: string; token: string } | null;
  /** Observe workflow-level subagent lifecycle updates from the server. */
  onSubagentEvent?: SubagentEventHandler;
  /** Observe workflow-level subagent batch updates from the server. */
  onSubagentBatchEvent?: SubagentBatchEventHandler;
  /** If set, the next stream call will POST as `regenerate-message` with
   *  this intent and then clear it (one-shot). The host sets this when the
   *  user edits a historical version and resends. */
  consumeRegenerateIntent?: () => {
    messageId: string;
    metadata?: unknown;
  } | null;
  /** Resolve the merged AGENTS.md content to forward to the Web backend
   *  on each turn. Returning "" / undefined skips the field entirely so
   *  the backend leaves the stored prompt untouched. The host typically
   *  reads `resourceLoader.getAgentsFiles()` here. */
  getAgentsMd?: () => string | undefined;
  /** Resolve the current plan-mode toggle. When true, the Web workflow
   *  filters its toolset to read-only / observe / reason tools only —
   *  the model can investigate and propose a plan but cannot mutate
   *  state. Set by the CLI `/plan` command. */
  getPlanMode?: () => boolean;
  /** Resolve the current thinking level. Forwarded to the Web workflow
   *  so it can serialize the matching provider-specific reasoning field
   *  (OpenAI reasoningEffort, Anthropic thinking.budgetTokens, Google
   *  thinkingConfig.thinkingBudget). Set by the CLI `/effort` command. */
  getThinkingLevel?: () => string | undefined;
  /** Resolve the current experimental client-spoof profile. */
  getClientSpoof?: () => string | undefined;
}

/**
 * Build a StreamFn that talks to the Agentboster web backend.
 *
 * The returned function ignores pi's `model` argument (the server picks
 * the model from session state) and ignores pi's `context.tools` (the
 * server owns tool execution). It only forwards the latest user text.
 */
export function createAgentbosterStreamFn(
  opts: CreateStreamFnOptions,
): StreamFn {
  return (
    _model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): ReturnType<StreamFn> => {
    const auth = opts.getAuth();
    if (!auth) {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: 'error',
        reason: 'error',
        error: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Not logged in. Run `agentboster-cli login` first.',
            },
          ],
          stopReason: 'error',
        } as never,
      });
      return stream;
    }
    const sessionId = opts.getSessionId();
    const regenerate = opts.consumeRegenerateIntent?.() ?? undefined;
    const agentsMd = opts.getAgentsMd?.() || undefined;
    const planMode = opts.getPlanMode?.() === true;
    const thinkingLevel = opts.getThinkingLevel?.();
    const clientSpoof = opts.getClientSpoof?.();
    return openAgentbosterStream(_model, context, {
      baseUrl: auth.baseUrl,
      token: auth.token,
      sessionId,
      clientId: opts.clientId,
      label: opts.label,
      model: opts.model,
      onLocalToolRequest: opts.onLocalToolRequest,
      onSubagentEvent: opts.onSubagentEvent,
      onSubagentBatchEvent: opts.onSubagentBatchEvent,
      signal: options?.signal,
      regenerate,
      planMode,
      thinkingLevel,
      clientSpoof,
      ...(agentsMd ? { agentsMd } : {}),
    });
  };
}
