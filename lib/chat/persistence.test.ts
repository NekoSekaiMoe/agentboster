import { describe, expect, it } from 'vitest';
import type { PersistedMessageRecord } from './message-utils';
import { deserializePersistedMessages } from './persistence';

function makeRow(input: Partial<PersistedMessageRecord>): PersistedMessageRecord {
  return {
    id: `row-${Math.random().toString(36).slice(2)}`,
    sessionId: 's1',
    role: 'assistant',
    visibleInChat: true,
    stepNumber: null,
    createdAt: new Date(0),
    uiMessageId: null,
    payload: {},
    ...input,
  } as PersistedMessageRecord;
}

describe('deserializePersistedMessages: multi-step with tools', () => {
  it('preserves user/assistant/tool order across multiple steps', () => {
    const t0 = new Date('2026-01-01T10:00:00.000Z');
    const t1 = new Date('2026-01-01T10:00:01.000Z');
    const t2 = new Date('2026-01-01T10:00:02.000Z');
    const t3 = new Date('2026-01-01T10:00:03.000Z');

    const rows: PersistedMessageRecord[] = [
      makeRow({
        role: 'user',
        uiMessageId: 'user-1',
        createdAt: t0,
        payload: { text: '查天气', parts: [{ type: 'text', text: '查天气' }] },
      }),
      makeRow({
        role: 'assistant',
        uiMessageId: 'assistant:run1:0',
        stepNumber: 0,
        createdAt: t1,
        payload: {
          text: '好的',
          parts: [
            { type: 'reasoning', text: '需要调用工具', state: 'done' },
            { type: 'text', text: '好的' },
          ],
        },
      }),
      makeRow({
        role: 'tool',
        uiMessageId: 'assistant:run1:0#tool:call-1',
        stepNumber: 0,
        createdAt: t1,
        payload: {
          toolName: 'get_weather',
          toolCallId: 'call-1',
          toolState: 'output-available',
          input: { city: '北京' },
          output: '25°',
        },
      }),
      makeRow({
        role: 'assistant',
        uiMessageId: 'assistant:run1:1',
        stepNumber: 1,
        createdAt: t2,
        payload: {
          text: '北京今天 25°',
          parts: [
            { type: 'reasoning', text: '第二步思考', state: 'done' },
            { type: 'text', text: '北京今天 25°' },
          ],
        },
      }),
      makeRow({
        role: 'user',
        uiMessageId: 'user-2',
        createdAt: t3,
        payload: { text: '谢谢', parts: [{ type: 'text', text: '谢谢' }] },
      }),
    ];

    const messages = deserializePersistedMessages(rows);

    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe('user');
    expect(messages[0].parts).toEqual([{ type: 'text', text: '查天气' }]);

    expect(messages[1].role).toBe('assistant');
    const partTypes1 = messages[1].parts.map((p) => p.type);
    expect(partTypes1).toEqual(['reasoning', 'text', 'dynamic-tool']);

    expect(messages[2].role).toBe('assistant');
    const partTypes2 = messages[2].parts.map((p) => p.type);
    expect(partTypes2).toEqual(['reasoning', 'text']);

    expect(messages[3].role).toBe('user');
    expect(messages[3].parts).toEqual([{ type: 'text', text: '谢谢' }]);
  });

  it('handles consecutive tool-calling steps (the reported bug)', () => {
    // Scenario from the user report: agent thinks → calls tool → thinks
    // again → calls another tool → finally answers. After reload only
    // the first reasoning survived and tool cards piled at the bottom.
    // All step rows share the SAME createdAt (millisecond precision, as
    // produced by stepCreatedAt in persistStepDeltaAndUsageStep when
    // steps run fast), so the tiebreaker is the only thing keeping
    // them in order.
    const t0 = new Date('2026-01-01T10:00:00.000Z');
    const tStep = new Date('2026-01-01T10:00:01.000Z');

    const rows: PersistedMessageRecord[] = [
      makeRow({
        role: 'user',
        uiMessageId: 'user-1',
        createdAt: t0,
        payload: { text: '帮我查北京和上海的天气', parts: [{ type: 'text', text: '帮我查北京和上海的天气' }] },
      }),
      // step 0: think + call get_weather(beijing)
      makeRow({
        role: 'assistant',
        uiMessageId: 'assistant:run1:0',
        stepNumber: 0,
        createdAt: tStep,
        payload: {
          text: '',
          parts: [{ type: 'reasoning', text: '先查北京', state: 'done' }],
        },
      }),
      makeRow({
        role: 'tool',
        uiMessageId: 'assistant:run1:0#tool:c1',
        stepNumber: 0,
        createdAt: tStep,
        payload: {
          toolName: 'get_weather',
          toolCallId: 'c1',
          toolState: 'output-available',
          input: { city: '北京' },
          output: '25°',
        },
      }),
      // step 1: think + call get_weather(shanghai)
      makeRow({
        role: 'assistant',
        uiMessageId: 'assistant:run1:1',
        stepNumber: 1,
        createdAt: tStep,
        payload: {
          text: '',
          parts: [{ type: 'reasoning', text: '再查上海', state: 'done' }],
        },
      }),
      makeRow({
        role: 'tool',
        uiMessageId: 'assistant:run1:1#tool:c2',
        stepNumber: 1,
        createdAt: tStep,
        payload: {
          toolName: 'get_weather',
          toolCallId: 'c2',
          toolState: 'output-available',
          input: { city: '上海' },
          output: '28°',
        },
      }),
      // step 2: final answer
      makeRow({
        role: 'assistant',
        uiMessageId: 'assistant:run1:2',
        stepNumber: 2,
        createdAt: tStep,
        payload: {
          text: '北京 25°，上海 28°',
          parts: [
            { type: 'reasoning', text: '汇总结果', state: 'done' },
            { type: 'text', text: '北京 25°，上海 28°' },
          ],
        },
      }),
    ];

    const messages = deserializePersistedMessages(rows);

    // Expect: user, then 3 separate assistant messages (one per step),
    // NOT user + one merged blob with tools at the bottom.
    expect(messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'assistant',
    ]);

    // step 0: reasoning + tool
    expect(messages[1].parts.map((p) => p.type)).toEqual([
      'reasoning',
      'dynamic-tool',
    ]);
    // step 1: reasoning + tool
    expect(messages[2].parts.map((p) => p.type)).toEqual([
      'reasoning',
      'dynamic-tool',
    ]);
    // step 2: reasoning + text
    expect(messages[3].parts.map((p) => p.type)).toEqual([
      'reasoning',
      'text',
    ]);
  });

  it('survives DB returning rows in random UUID order within same createdAt', () => {
    // The DB query orders by (created_at, id) where id is a random UUID.
    // When multiple rows share the same createdAt (same step), their
    // relative order from the DB is effectively random. Simulate the
    // worst case: tool rows come BEFORE the assistant text row.
    const t = new Date('2026-01-01T10:00:00.000Z');

    const rows: PersistedMessageRecord[] = [
      // DB returned tools first (random UUID sort)
      makeRow({
        role: 'tool',
        uiMessageId: 'assistant:run1:0#tool:c2',
        stepNumber: 0,
        createdAt: t,
        payload: {
          toolName: 'get_weather',
          toolCallId: 'c2',
          toolState: 'output-available',
          input: { city: '上海' },
          output: '28°',
        },
      }),
      makeRow({
        role: 'tool',
        uiMessageId: 'assistant:run1:0#tool:c1',
        stepNumber: 0,
        createdAt: t,
        payload: {
          toolName: 'get_weather',
          toolCallId: 'c1',
          toolState: 'output-available',
          input: { city: '北京' },
          output: '25°',
        },
      }),
      makeRow({
        role: 'assistant',
        uiMessageId: 'assistant:run1:0',
        stepNumber: 0,
        createdAt: t,
        payload: {
          text: '查询中',
          parts: [
            { type: 'reasoning', text: '需要调用工具', state: 'done' },
            { type: 'text', text: '查询中' },
          ],
        },
      }),
    ];

    const messages = deserializePersistedMessages(rows);

    expect(messages).toHaveLength(1);
    // assistant text + reasoning MUST come before tool cards
    expect(messages[0].parts.map((p) => p.type)).toEqual([
      'reasoning',
      'text',
      'dynamic-tool',
      'dynamic-tool',
    ]);
  });

  it('does not collapse user messages to the bottom', () => {
    const t0 = new Date('2026-01-01T10:00:00.000Z');
    const t1 = new Date('2026-01-01T10:00:01.000Z');
    const t2 = new Date('2026-01-01T10:00:02.000Z');

    const rows: PersistedMessageRecord[] = [
      makeRow({
        role: 'user',
        uiMessageId: 'user-1',
        createdAt: t0,
        payload: { text: '你好', parts: [{ type: 'text', text: '你好' }] },
      }),
      makeRow({
        role: 'assistant',
        uiMessageId: 'assistant:run1:0',
        stepNumber: 0,
        createdAt: t1,
        payload: {
          text: '你好！',
          parts: [{ type: 'text', text: '你好！' }],
        },
      }),
      makeRow({
        role: 'user',
        uiMessageId: 'user-2',
        createdAt: t2,
        payload: { text: '再见', parts: [{ type: 'text', text: '再见' }] },
      }),
    ];

    const messages = deserializePersistedMessages(rows);

    expect(messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });
});
