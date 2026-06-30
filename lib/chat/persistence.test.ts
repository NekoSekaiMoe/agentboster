import { describe, it, expect } from 'vitest';
import { deserializePersistedMessages } from '@/lib/chat/persistence';
import type { PersistedMessageRecord } from '@/lib/chat/message-utils';

// Reproduce the "tool card jumps below LLM text on refresh" bug.
//
// Streaming order (what the user sees live, from AI SDK push-based parts):
//   [tool-call, tool-output, text]
//
// Persistence: persistStepDeltaAndUsageStep writes the assistant text row
// first, then iterates step.toolCalls writing one tool row each, all with
// the same stepCreatedAt and the same stepNumber. After a reload,
// persistence.ts sorts within the group by role rank (assistant=0,
// tool=1), producing [text, tool] — the tool card now renders *after*
// the LLM text instead of before it.

const STEP_ID = 'step-1';
const STEP_AT = new Date('2026-06-30T00:00:00.000Z');
const STEP_NUM = 5;

function mkAssistantRow(
  overrides: Partial<PersistedMessageRecord> = {},
): PersistedMessageRecord {
  return {
    id: 'row-assistant',
    sessionId: 's1',
    role: 'assistant',
    uiMessageId: STEP_ID,
    visibleInChat: true,
    stepNumber: STEP_NUM,
    createdAt: STEP_AT,
    payload: {
      text: 'Here is the summary after the tool ran.',
      parts: [
        { type: 'text', text: 'Here is the summary after the tool ran.' },
      ],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      metadata: { stepNumber: STEP_NUM, createdAt: STEP_AT.toISOString() },
    },
    ...overrides,
  };
}

function mkToolRow(
  toolCallId: string,
  overrides: Partial<PersistedMessageRecord> = {},
): PersistedMessageRecord {
  return {
    id: `row-tool-${toolCallId}`,
    sessionId: 's1',
    role: 'tool',
    uiMessageId: `${STEP_ID}#tool:${toolCallId}`,
    visibleInChat: true,
    stepNumber: STEP_NUM,
    createdAt: STEP_AT,
    payload: {
      toolCallId,
      toolName: 'lookup',
      toolState: 'output-available',
      input: { q: 'hello' },
      output: 'world',
      finishReason: 'stop',
    },
    ...overrides,
  };
}

describe('buildMessage part ordering (bug repro: tool jumps below text on reload)', () => {
  it('reproduces the streaming order: tool card BEFORE text', () => {
    // Simulate DB-returned order: assistant row persisted first (text),
    // tool rows persisted after. This mirrors persistStepDeltaAndUsageStep.
    const rows = [mkAssistantRow(), mkToolRow('tc-1')];

    const messages = deserializePersistedMessages(rows);
    expect(messages).toHaveLength(1);

    const parts = messages[0]?.parts ?? [];

    // Expected streaming order: [tool, text]
    // Buggy persisted order: [text, tool]
    const partKinds = parts.map((p) => p.type);
    console.log('actual part order:', partKinds);
    // The streaming order (what the user saw before refresh):
    //   ['dynamic-tool', 'text']
    // The buggy reload order:
    //   ['text', 'dynamic-tool']
    // After the fix, the reload order matches streaming: tool before text.
    expect(partKinds).toEqual(['dynamic-tool', 'text']);
  });

  it('preserves order for multiple tool calls within one step', () => {
    const rows = [mkAssistantRow(), mkToolRow('tc-1'), mkToolRow('tc-2')];

    const messages = deserializePersistedMessages(rows);
    expect(messages).toHaveLength(1);
    const parts = messages[0]?.parts ?? [];
    const partKinds = parts.map((p) => p.type);

    // All tool cards before the final text summary.
    expect(partKinds).toEqual(['dynamic-tool', 'dynamic-tool', 'text']);
  });

  it('still works for plain-text steps with no tool calls', () => {
    const rows = [mkAssistantRow()];
    const messages = deserializePersistedMessages(rows);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts.map((p) => p.type)).toEqual(['text']);
  });

  it('honours payload.partIndex when present, overriding role rank', () => {
    // Forward-compat: if a future change annotates rows with explicit
    // streaming order, that order wins over the static rank. This lets
    // persistStepDeltaAndUsageStep switch to recording real part order
    // without needing a parallel buildMessage rewrite.
    const rows = [
      {
        ...mkAssistantRow(),
        payload: { ...mkAssistantRow().payload, partIndex: 0 },
      },
      {
        ...mkToolRow('tc-1'),
        payload: { ...mkToolRow('tc-1').payload, partIndex: 1 },
      },
    ];

    const messages = deserializePersistedMessages(rows);
    const parts = messages[0]?.parts ?? [];
    // partIndex forces text (0) ahead of tool (1), opposite of the
    // default rank — proving partIndex is the source of truth.
    expect(parts.map((p) => p.type)).toEqual(['text', 'dynamic-tool']);
  });
});
