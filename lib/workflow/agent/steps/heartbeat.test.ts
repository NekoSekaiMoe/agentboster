import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import {
  extractFinalAssistantText,
  extractHeartbeatDecision,
} from './heartbeat';

function stepWithCalls(...calls: Array<{ toolName: string; input?: unknown }>) {
  return { toolCalls: calls };
}

describe('extractHeartbeatDecision', () => {
  it('reads the reply from the heartbeat_decision tool call input', () => {
    const decision = extractHeartbeatDecision([
      stepWithCalls({
        toolName: 'heartbeat_decision',
        input: { reply: false, reason: 'nothing worth saying' },
      }),
    ]);
    expect(decision).toEqual({
      reply: false,
      reason: 'nothing worth saying',
    });
  });

  it('scans past unrelated tool calls', () => {
    const decision = extractHeartbeatDecision([
      stepWithCalls({ toolName: 'read_file', input: { path: 'x' } }),
      stepWithCalls({ toolName: 'heartbeat_decision', input: { reply: true } }),
    ]);
    expect(decision).toEqual({ reply: true, reason: undefined });
  });

  it('returns null (fail-closed silence) when the tool was never called', () => {
    expect(
      extractHeartbeatDecision([stepWithCalls({ toolName: 'web_search' })]),
    ).toBeNull();
    expect(extractHeartbeatDecision([])).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(
      extractHeartbeatDecision([
        stepWithCalls({
          toolName: 'heartbeat_decision',
          input: { reply: 'yes' },
        }),
      ]),
    ).toBeNull();
  });
});

describe('extractFinalAssistantText', () => {
  it('returns the last assistant message text', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'old reply' },
      { role: 'user', content: 'again' },
      { role: 'assistant', content: [{ type: 'text', text: 'final reply' }] },
    ];
    expect(extractFinalAssistantText(messages)).toBe('final reply');
  });

  it('returns null when the last assistant message is empty', () => {
    const messages: ModelMessage[] = [{ role: 'assistant', content: '   ' }];
    expect(extractFinalAssistantText(messages)).toBeNull();
  });

  it('returns null with no assistant messages', () => {
    expect(
      extractFinalAssistantText([{ role: 'user', content: 'hi' }]),
    ).toBeNull();
  });
});
