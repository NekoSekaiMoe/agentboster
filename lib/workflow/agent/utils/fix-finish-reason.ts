/**
 * Language model middleware that fixes a common bug in third-party
 * OpenAI-compatible APIs: the model returns tool_calls in the response
 * but sets finish_reason to "stop" instead of "tool_calls".
 *
 * When this happens, DurableAgent sees finishReason="stop" and ends the
 * agent loop without executing any tools. The tool calls remain in the
 * "input-available" state forever, and the user sees tools that never
 * complete ("正在使用" instead of "已使用").
 *
 * This middleware inspects the provider's raw stream and, if it saw
 * tool-call-related chunks followed by a "stop" finish, rewrites the
 * finish reason to "tool-calls" so DurableAgent correctly enters its
 * tool-execution path.
 *
 * Why a middleware (not experimental_transform)?
 *
 *   DurableAgent.stream() forwards `experimental_transform` into the
 *   `transforms` array of the internal `doStreamStep` call, which is a
 *   `'use step'` function in the Vercel Workflow DevKit. Step arguments
 *   must be serializable (Devalue), and functions cannot be serialized.
 *   Passing a transform function therefore crashes the workflow with
 *   "Cannot stringify a function" during the LLM thinking phase.
 *
 *   A language-model middleware, by contrast, is applied when the model
 *   instance is constructed inside the model resolver (itself a
 *   `'use step'` function). The wrapped model is the *return value* of
 *   that step, so the middleware never appears in any step's serialized
 *   arguments. doStreamStep receives the already-wrapped model via the
 *   modelInit factory and invokes wrapStream transparently.
 */

import { createLogger } from '@/lib/utils/logger';
import type {
  LanguageModelV3,
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { wrapLanguageModel } from 'ai';

const logger = createLogger('workflow.agent.fix-finish-reason');

/**
 * Build a middleware that rewrites a "stop" finish reason to "tool-calls"
 * when the stream emitted at least one tool-call chunk. The middleware is
 * stateful per stream invocation, so a fresh instance must be used for
 * every doStream call (wrapStream creates the tracking state on entry).
 */
export function fixFinishReasonMiddleware(): LanguageModelV3Middleware {
  return {
    specificationVersion: 'v3',
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      let sawToolCall = false;

      const transformedStream = result.stream.pipeThrough(
        new TransformStream<
          LanguageModelV3StreamPart,
          LanguageModelV3StreamPart
        >({
          transform(chunk, controller) {
            // tool-input-start is emitted by the provider when the model
            // begins streaming a tool call. tool-call is the complete,
            // final tool call. Either of these means the model emitted at
            // least one tool call, so the finish reason should be
            // "tool-calls", not "stop".
            if (
              chunk.type === 'tool-input-start' ||
              chunk.type === 'tool-call'
            ) {
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
        }),
      );

      return { ...result, stream: transformedStream };
    },
  };
}

/**
 * Wrap a language model with the finish-reason fix. The returned model
 * behaves identically to the input except that its stream output has the
 * stop→tool-calls finish reason rewrite applied.
 *
 * Call this inside a `'use step'` model resolver so the wrapping happens
 * within the step and never needs to be serialized as a step argument.
 */
export function withFinishReasonFix(model: LanguageModelV3): LanguageModelV3 {
  return wrapLanguageModel({
    model,
    middleware: fixFinishReasonMiddleware(),
  });
}
