/**
 * Stream transform that fixes a common bug in third-party OpenAI-compatible
 * APIs: the model returns tool_calls in the response but sets finish_reason
 * to "stop" instead of "tool_calls".
 *
 * When this happens, DurableAgent sees finishReason="stop" and ends the
 * agent loop without executing any tools. The tool calls remain in the
 * "input-available" state forever, and the user sees tools that never
 * complete ("正在使用" instead of "已使用").
 *
 * This transform inspects the stream and, if it saw tool-call-related
 * chunks followed by a "stop" finish, rewrites the finish reason to
 * "tool-calls" so DurableAgent correctly enters its tool-execution path.
 */

import { createLogger } from '@/lib/utils/logger';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';

const logger = createLogger('workflow.agent.fix-finish-reason');

/**
 * StreamTextTransform factory.
 *
 * DurableAgent calls this function with { tools, stopStream } and expects
 * a TransformStream back. Each call creates a fresh stream with its own
 * per-step tracking state.
 */
export function fixFinishReasonWithToolCalls(_options: {
  tools: unknown;
  stopStream: () => void;
}): TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart> {
  let sawToolCall = false;

  return new TransformStream<
    LanguageModelV3StreamPart,
    LanguageModelV3StreamPart
  >({
    transform(chunk, controller) {
      // tool-input-start is emitted by the provider when the model begins
      // streaming a tool call. tool-call is the complete, final tool call.
      // Either of these means the model emitted at least one tool call,
      // so the finish reason should be "tool-calls", not "stop".
      if (chunk.type === 'tool-input-start' || chunk.type === 'tool-call') {
        sawToolCall = true;
      }

      if (chunk.type === 'finish') {
        if (sawToolCall && chunk.finishReason.unified === 'stop') {
          logger.warn('fix:stop_to_tool_calls', {
            rawFinishReason: chunk.finishReason.raw,
            sawToolCall,
            message:
              'Provider returned finish_reason "stop" despite emitting tool calls. Rewriting to "tool-calls" so DurableAgent executes the tools.',
          });
          controller.enqueue({
            ...chunk,
            finishReason: {
              ...chunk.finishReason,
              unified: 'tool-calls',
            },
          });
          return;
        }
      }

      controller.enqueue(chunk);
    },
  });
}
