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

// Multi-step agent turn coalescing.
//
// While streaming, AI SDK's ToolLoopAgent appends every step's parts
// (reasoning/tool/text) onto a single UI message — that's what the user
// sees live. But persistence writes one row per step (each with its own
// `assistant:<runId>:<stepNumber>` uiMessageId), so reload must merge
// consecutive assistant steps of the same turn back into one message,
// otherwise the user sees N split bubbles (each with its own action row
// and only its own slice of reasoning). persistStepDeltaAndUsageStep
// stamps payload.metadata.runId onto every row of the turn; the loader
// uses that marker to coalesce.

const RUN_X = 'run-x';

function mkUserRow(text: string, createdAt: Date): PersistedMessageRecord {
  return {
    id: `row-user-${createdAt.getTime()}`,
    sessionId: 's1',
    role: 'user',
    uiMessageId: `user-${createdAt.getTime()}`,
    visibleInChat: true,
    createdAt,
    payload: { text, parts: [{ type: 'text', text }] },
  };
}

function mkStepAssistantRow(input: {
  runId: string;
  stepNumber: number;
  createdAt: Date;
  text: string;
  reasoning?: string;
}): PersistedMessageRecord {
  const { runId, stepNumber, createdAt, text, reasoning } = input;
  const id = `assistant:${runId}:${stepNumber}`;
  const parts: Array<
    | { type: 'reasoning'; text: string; state: 'done' }
    | { type: 'text'; text: string }
  > = [];
  if (reasoning && reasoning.trim().length > 0) {
    parts.push({ type: 'reasoning', text: reasoning, state: 'done' });
  }
  parts.push({ type: 'text', text });
  return {
    id: `row-${id}`,
    sessionId: 's1',
    role: 'assistant',
    uiMessageId: id,
    visibleInChat: true,
    stepNumber,
    createdAt,
    payload: {
      text,
      parts,
      finishReason: 'stop',
      metadata: { runId, stepNumber, createdAt: createdAt.toISOString() },
    },
  };
}

function mkStepToolRow(input: {
  runId: string;
  stepNumber: number;
  createdAt: Date;
  toolCallId: string;
}): PersistedMessageRecord {
  const { runId, stepNumber, createdAt, toolCallId } = input;
  const parentId = `assistant:${runId}:${stepNumber}`;
  return {
    id: `row-tool-${toolCallId}`,
    sessionId: 's1',
    role: 'tool',
    uiMessageId: `${parentId}#tool:${toolCallId}`,
    visibleInChat: true,
    stepNumber,
    createdAt,
    payload: {
      toolCallId,
      toolName: 'lookup',
      toolState: 'output-available',
      input: { q: 'x' },
      output: 'y',
      finishReason: 'tool-calls',
      metadata: { runId, stepNumber },
    },
  };
}

describe('multi-step turn coalescing (bug repro: split bubbles + lost reasoning on reload)', () => {
  it('merges consecutive assistant steps of one turn into a single UI message', () => {
    const rows = [
      mkUserRow('hi', new Date('2026-06-29T00:00:00.000Z')),
      mkStepAssistantRow({
        runId: RUN_X,
        stepNumber: 0,
        createdAt: new Date('2026-06-30T00:00:00.000Z'),
        text: 'think1-text',
        reasoning: 'think1-reasoning',
      }),
      mkStepAssistantRow({
        runId: RUN_X,
        stepNumber: 1,
        createdAt: new Date('2026-06-30T00:00:01.000Z'),
        text: 'think2-text',
        reasoning: 'think2-reasoning',
      }),
      mkStepToolRow({
        runId: RUN_X,
        stepNumber: 1,
        createdAt: new Date('2026-06-30T00:00:01.000Z'),
        toolCallId: 'tc-1',
      }),
      mkStepAssistantRow({
        runId: RUN_X,
        stepNumber: 2,
        createdAt: new Date('2026-06-30T00:00:02.000Z'),
        text: 'final-text',
        reasoning: 'final-reasoning',
      }),
    ];

    const msgs = deserializePersistedMessages(rows);
    expect(msgs).toHaveLength(2); // user + one merged assistant
    const assistant = msgs[1];
    expect(assistant?.role).toBe('assistant');

    // Every reasoning survives (this is the bug: "only first reasoning left").
    const reasoningTexts = (assistant?.parts ?? [])
      .filter((p) => p.type === 'reasoning')
      .map((p) => (p as { text: string }).text);
    expect(reasoningTexts).toEqual([
      'think1-reasoning',
      'think2-reasoning',
      'final-reasoning',
    ]);

    // Every text survives and stays in order.
    const textParts = (assistant?.parts ?? [])
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text);
    expect(textParts).toEqual(['think1-text', 'think2-text', 'final-text']);

    // Tool card from step 1 is inside the merged message.
    expect(
      (assistant?.parts ?? []).some((p) => p.type === 'dynamic-tool'),
    ).toBe(true);

    // Internal runId marker must not leak into the UI message metadata.
    expect(assistant?.metadata).not.toHaveProperty('runId');
  });

  it('does NOT merge across turns (separated by a user message)', () => {
    const rows = [
      mkUserRow('q1', new Date('2026-06-29T00:00:00.000Z')),
      mkStepAssistantRow({
        runId: 'run-A',
        stepNumber: 0,
        createdAt: new Date('2026-06-30T00:00:00.000Z'),
        text: 'a1',
        reasoning: 'a1-r',
      }),
      mkUserRow('q2', new Date('2026-06-30T00:30:00.000Z')),
      mkStepAssistantRow({
        runId: 'run-B',
        stepNumber: 0,
        createdAt: new Date('2026-06-30T00:30:01.000Z'),
        text: 'a2',
        reasoning: 'a2-r',
      }),
    ];

    const msgs = deserializePersistedMessages(rows);
    expect(msgs).toHaveLength(4);
    expect(msgs.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('does NOT merge legacy rows that lack runId (one message per step)', () => {
    const rows = [
      mkStepAssistantRow({
        runId: 'legacy',
        stepNumber: 0,
        createdAt: new Date('2026-06-30T00:00:00.000Z'),
        text: 'a1',
        reasoning: 'a1-r',
      }),
      mkStepAssistantRow({
        runId: 'legacy',
        stepNumber: 1,
        createdAt: new Date('2026-06-30T00:00:01.000Z'),
        text: 'a2',
        reasoning: 'a2-r',
      }),
    ];
    // Simulate legacy: strip runId from payload.metadata.
    const legacy = rows.map((r) => ({
      ...r,
      payload: { ...r.payload, metadata: { stepNumber: r.stepNumber } },
    }));

    const msgs = deserializePersistedMessages(legacy);
    expect(msgs).toHaveLength(2);
  });

  it('keeps separate turns distinct when both are multi-step', () => {
    const rows = [
      mkUserRow('q1', new Date('2026-06-29T00:00:00.000Z')),
      mkStepAssistantRow({
        runId: 'run-A',
        stepNumber: 0,
        createdAt: new Date('2026-06-30T00:00:00.000Z'),
        text: 't1s0',
        reasoning: 't1s0-r',
      }),
      mkStepAssistantRow({
        runId: 'run-A',
        stepNumber: 1,
        createdAt: new Date('2026-06-30T00:00:01.000Z'),
        text: 't1s1',
        reasoning: 't1s1-r',
      }),
      mkUserRow('q2', new Date('2026-06-30T00:30:00.000Z')),
      mkStepAssistantRow({
        runId: 'run-B',
        stepNumber: 0,
        createdAt: new Date('2026-06-30T00:30:01.000Z'),
        text: 't2s0',
        reasoning: 't2s0-r',
      }),
    ];

    const msgs = deserializePersistedMessages(rows);
    expect(msgs).toHaveLength(4);
    expect(msgs[1]?.parts.filter((p) => p.type === 'reasoning')).toHaveLength(
      2,
    );
    expect(msgs[3]?.parts.filter((p) => p.type === 'reasoning')).toHaveLength(
      1,
    );
  });
});
