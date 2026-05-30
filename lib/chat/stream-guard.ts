import type { WorkflowUIMessageChunk } from '@/types/workflow';

/**
 * Wraps a workflow UI message stream and ensures every text-delta is preceded
 * by a text-start (and reasoning-delta by reasoning-start). The AI SDK pipes
 * raw chunks into the workflow writable, so providers that emit deltas without
 * a prior start would otherwise reach the client unchecked, which makes the
 * client throw "text-delta for missing text part".
 */
export function guardWorkflowChunks(
  source: ReadableStream<WorkflowUIMessageChunk>,
): ReadableStream<WorkflowUIMessageChunk> {
  const startedTextParts = new Set<string>();
  const startedReasoningParts = new Set<string>();

  const transform = new TransformStream<
    WorkflowUIMessageChunk,
    WorkflowUIMessageChunk
  >({
    transform(chunk, controller) {
      if (chunk.type === 'text-start' && chunk.id) {
        startedTextParts.add(chunk.id);
      } else if (chunk.type === 'text-delta' && chunk.id) {
        if (!startedTextParts.has(chunk.id)) {
          startedTextParts.add(chunk.id);
          controller.enqueue({ type: 'text-start', id: chunk.id });
        }
      } else if (chunk.type === 'text-end' && chunk.id) {
        startedTextParts.delete(chunk.id);
      } else if (chunk.type === 'reasoning-start' && chunk.id) {
        startedReasoningParts.add(chunk.id);
      } else if (chunk.type === 'reasoning-delta' && chunk.id) {
        if (!startedReasoningParts.has(chunk.id)) {
          startedReasoningParts.add(chunk.id);
          controller.enqueue({ type: 'reasoning-start', id: chunk.id });
        }
      } else if (chunk.type === 'reasoning-end' && chunk.id) {
        startedReasoningParts.delete(chunk.id);
      }

      controller.enqueue(chunk);
    },
  });

  return source.pipeThrough(transform);
}
