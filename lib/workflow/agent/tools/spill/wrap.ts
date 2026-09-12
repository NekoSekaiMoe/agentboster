/**
 * Tool-result spill wrapper — the tools/post-execute analog of dsh's
 * spill-policy plugin (see ref/deepseek-harness packages/spill).
 *
 * Applied in `defineBuildInTool.register()` OUTSIDE the timeout guard
 * (spill observes the final outcome — a timed-out tool returns the small
 * structured timeout result and passes through untouched).
 *
 * Behavior:
 *  - Serialize the result exactly the way persistence would (JSON
 *    pretty-print, String() fallback).
 *  - At or below the threshold: pass through unchanged.
 *  - Above the threshold: store the full text in the dual-backend KV (with
 *    TTL) and return a bounded preview + locator + retrieval hint instead.
 *    The spill id is the call's toolCallId, so it is deterministic under
 *    workflow replay.
 *  - Storage failure NEVER fails the tool: on error the original result is
 *    returned unchanged (persistence truncation then applies as before) —
 *    degradation, not regression.
 */
import { createLogger } from '@/lib/utils/logger';
import type { ToolSet } from 'ai';
import {
  buildSpillReplacement,
  resolveSpillSettings,
  serializeForSpill,
} from './core';
import { putSpill } from './store';

const logger = createLogger('workflow.agent.tools.spill');

export function withToolResultSpill(
  tool: ToolSet[string],
  options?: { sessionId?: string },
): ToolSet[string] {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const sessionId = options?.sessionId;

  return {
    ...tool,
    execute: async (input, execOptions) => {
      const result = await execute(input, execOptions);
      try {
        return await maybeSpill(result, execOptions?.toolCallId, sessionId);
      } catch (error) {
        logger.warn('spill:store_failed', {
          toolCallId: execOptions?.toolCallId,
          error: error instanceof Error ? error.message : String(error),
        });
        return result;
      }
    },
  };
}

async function maybeSpill(
  result: unknown,
  toolCallId: string | undefined,
  sessionId: string | undefined,
): Promise<unknown> {
  const settings = resolveSpillSettings();
  if (settings.disabled || !toolCallId) {
    return result;
  }
  const serialized = serializeForSpill(result);
  if (serialized.length <= settings.thresholdChars) {
    return result;
  }

  const spillId = toolCallId;
  await putSpill(
    spillId,
    {
      text: serialized.slice(0, settings.maxStoreChars),
      totalChars: serialized.length,
      // Session binding: deterministic under workflow replay (same session
      // → same value) and enforced on read by getSpill.
      ...(sessionId !== undefined ? { sessionId } : {}),
      createdAt: new Date().toISOString(),
    },
    settings.ttlSeconds,
  );
  logger.info('spill:stored', {
    spillId,
    totalChars: serialized.length,
    storedChars: Math.min(serialized.length, settings.maxStoreChars),
  });
  return buildSpillReplacement({ spillId, text: serialized, settings });
}
