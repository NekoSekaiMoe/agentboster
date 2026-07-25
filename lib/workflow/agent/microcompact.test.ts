import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import {
  CLEARED_TOOL_RESULT,
  DEFAULT_MICROCOMPACT_CONFIG,
  microcompact,
  resolveMicrocompactConfig,
  shouldMicrocompact,
} from './microcompact';

function assistantWithCalls(toolCallIds: string[]): ModelMessage {
  return {
    role: 'assistant',
    content: toolCallIds.map((id) => ({
      type: 'tool-call' as const,
      toolCallId: id,
      toolName: 'read_file',
      input: { path: `/f-${id}` },
    })),
  } as unknown as ModelMessage;
}
function toolMsg(
  toolCallId: string,
  output = `output-${toolCallId}`,
): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId, output }],
  } as unknown as ModelMessage;
}

describe('resolveMicrocompactConfig', () => {
  it('returns defaults with no override', () => {
    const c = resolveMicrocompactConfig();
    expect(c.enabled).toBe(true);
    expect(c.keepRecent).toBe(4);
    expect(c.compactableTools.length).toBeGreaterThan(0);
  });

  it('accepts snake_case overrides', () => {
    const c = resolveMicrocompactConfig({
      enabled: false,
      keep_recent: 2,
      compactable_tools: ['foo'],
      min_results_to_trigger: 1,
    });
    expect(c.enabled).toBe(false);
    expect(c.keepRecent).toBe(2);
    expect(c.compactableTools).toEqual(['foo']);
    expect(c.minResultsToTrigger).toBe(1);
  });
});

describe('shouldMicrocompact', () => {
  it('false when disabled', () => {
    expect(
      shouldMicrocompact([], {
        ...DEFAULT_MICROCOMPACT_CONFIG,
        enabled: false,
      }),
    ).toBe(false);
  });

  it('false when compactable results below threshold (keepRecent*2)', () => {
    const msgs = [assistantWithCalls(['a', 'b']), toolMsg('a'), toolMsg('b')];
    // keepRecent=4 default -> threshold 8. 2 results < 8 -> no.
    expect(shouldMicrocompact(msgs, DEFAULT_MICROCOMPACT_CONFIG)).toBe(false);
  });

  it('true when compactable results exceed threshold', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
    const msgs = [assistantWithCalls(ids), ...ids.map((id) => toolMsg(id))];
    expect(shouldMicrocompact(msgs, DEFAULT_MICROCOMPACT_CONFIG)).toBe(true);
  });

  it('ignores non-compactable tools', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
    // toolName not in the compactable list -> results don't count
    const assistant = {
      role: 'assistant',
      content: ids.map((id) => ({
        type: 'tool-call',
        toolCallId: id,
        toolName: 'write_memory',
        input: {},
      })),
    } as unknown as ModelMessage;
    const msgs = [assistant, ...ids.map((id) => toolMsg(id))];
    expect(shouldMicrocompact(msgs, DEFAULT_MICROCOMPACT_CONFIG)).toBe(false);
  });
});

describe('microcompact', () => {
  it('noop when disabled', () => {
    const msgs = [assistantWithCalls(['a']), toolMsg('a')];
    const { messages, result } = microcompact(msgs, {
      ...DEFAULT_MICROCOMPACT_CONFIG,
      enabled: false,
    });
    expect(messages).toBe(msgs);
    expect(result.ran).toBe(false);
  });

  it('noop when below threshold', () => {
    const msgs = [assistantWithCalls(['a', 'b']), toolMsg('a'), toolMsg('b')];
    const { messages, result } = microcompact(
      msgs,
      DEFAULT_MICROCOMPACT_CONFIG,
    );
    expect(messages).toBe(msgs);
    expect(result.ran).toBe(false);
  });

  it('clears all but the keepRecent most-recent compactable results', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const msgs = [
      assistantWithCalls(ids),
      ...ids.map((id) => toolMsg(id, `data-${id}`)),
    ];
    const { messages, result } = microcompact(msgs, {
      ...DEFAULT_MICROCOMPACT_CONFIG,
      keepRecent: 2,
      minResultsToTrigger: 2,
    });
    expect(result.ran).toBe(true);
    expect(result.clearedCount).toBe(4); // 6 total - 2 kept
    const toolMessages = messages.filter((m) => m.role === 'tool');
    // Last 2 (e, f) kept intact; first 4 cleared.
    expect(extractOutput(toolMessages[4])).toBe('data-e');
    expect(extractOutput(toolMessages[5])).toBe('data-f');
    expect(extractOutput(toolMessages[0])).toBe(CLEARED_TOOL_RESULT);
    expect(extractOutput(toolMessages[1])).toBe(CLEARED_TOOL_RESULT);
    expect(extractOutput(toolMessages[2])).toBe(CLEARED_TOOL_RESULT);
    expect(extractOutput(toolMessages[3])).toBe(CLEARED_TOOL_RESULT);
  });

  it('does not mutate input', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `c${i}`);
    const msgs = [assistantWithCalls(ids), ...ids.map((id) => toolMsg(id))];
    const snapshot = JSON.parse(JSON.stringify(msgs));
    microcompact(msgs, {
      ...DEFAULT_MICROCOMPACT_CONFIG,
      keepRecent: 2,
      minResultsToTrigger: 2,
    });
    expect(msgs).toEqual(snapshot);
  });

  it('already-cleared results do not count toward keep budget', () => {
    // 6 results, 2 already cleared. keepRecent=2. Live=4 > trigger(4)? no, 4 is not > 4.
    // Use keepRecent=2, minResultsToTrigger=2 -> live=4 > 2 -> run.
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const msgs = [
      assistantWithCalls(ids),
      toolMsg('a', CLEARED_TOOL_RESULT),
      toolMsg('b', CLEARED_TOOL_RESULT),
      toolMsg('c'),
      toolMsg('d'),
      toolMsg('e'),
      toolMsg('f'),
    ];
    const { result } = microcompact(msgs, {
      ...DEFAULT_MICROCOMPACT_CONFIG,
      keepRecent: 2,
      minResultsToTrigger: 2,
    });
    expect(result.ran).toBe(true);
    // Live results were c,d,e,f (4). keepRecent 2 -> clear 2 (c, d).
    expect(result.clearedCount).toBe(2);
  });

  it('estimates tokens freed as bytes/4', () => {
    const big = 'x'.repeat(400);
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const msgs = [
      assistantWithCalls(ids),
      ...ids.map((id) => toolMsg(id, big)),
    ];
    const { result } = microcompact(msgs, {
      ...DEFAULT_MICROCOMPACT_CONFIG,
      keepRecent: 1,
      minResultsToTrigger: 1,
    });
    expect(result.ran).toBe(true);
    // 5 results, keep 1 -> clear 4, each 400 bytes -> 100 tokens each -> 400 total.
    expect(result.estimatedTokensFreed).toBe(400);
  });

  it('respects compactableTools filter', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `c${i}`);
    const assistant = {
      role: 'assistant',
      content: ids.map((id) => ({
        type: 'tool-call',
        toolCallId: id,
        toolName: 'secret_tool',
        input: {},
      })),
    } as unknown as ModelMessage;
    const msgs = [assistant, ...ids.map((id) => toolMsg(id, 'data'))];
    // secret_tool not in compactable list -> nothing happens
    const { result, messages } = microcompact(
      msgs,
      DEFAULT_MICROCOMPACT_CONFIG,
    );
    expect(result.ran).toBe(false);
    expect(messages).toBe(msgs);
  });

  it('handles tool results spread across multiple tool messages', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const msgs = [
      assistantWithCalls(ids),
      toolMsg('a'),
      toolMsg('b'),
      toolMsg('c'),
      toolMsg('d'),
      toolMsg('e'),
    ];
    const { result, messages } = microcompact(msgs, {
      ...DEFAULT_MICROCOMPACT_CONFIG,
      keepRecent: 2,
      minResultsToTrigger: 2,
    });
    expect(result.clearedCount).toBe(3);
    // Original messages array length preserved
    expect(messages).toHaveLength(msgs.length);
  });
});

function extractOutput(msg: ModelMessage): unknown {
  const parts = msg.content as unknown as { output?: unknown }[];
  return parts[0]?.output;
}
