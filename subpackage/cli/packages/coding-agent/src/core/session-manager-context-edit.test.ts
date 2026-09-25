import { describe, expect, it } from 'vitest';
import type { AssistantMessage, UserMessage } from '@agentboster-cli/ai';
import { SessionManager } from './session-manager.ts';

function userMessage(text: string): UserMessage {
  return {
    role: 'user',
    content: text,
    timestamp: Date.now(),
  };
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function lastUserText(
  messages: ReturnType<SessionManager['buildSessionContext']>['messages'],
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user') {
      const content = message.content;
      return typeof content === 'string'
        ? content
        : content
            .filter(
              (c): c is { type: 'text'; text: string } => c.type === 'text',
            )
            .map((c) => c.text)
            .join('');
    }
  }
  return '';
}

describe('SessionManager context edits (pi 0.87.0)', () => {
  it('appendContextEdit(target, null) omits the message from provider context', () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage(userMessage('keep me'));
    const dropId = manager.appendMessage(userMessage('drop me'));
    manager.appendContextEdit(dropId, null);

    const context = manager.buildSessionContext();
    expect(context.messages).toHaveLength(1);
    expect(lastUserText(context.messages)).toBe('keep me');
    // Raw history is unchanged: all three entries remain.
    expect(manager.getEntries()).toHaveLength(3);
  });

  it('appendContextEdit replacement content is used for future requests', () => {
    const manager = SessionManager.inMemory();
    const targetId = manager.appendMessage(userMessage('original'));
    manager.appendContextEdit(targetId, 'replaced text');

    const context = manager.buildSessionContext();
    expect(context.messages).toHaveLength(1);
    expect(lastUserText(context.messages)).toBe('replaced text');
  });

  it('string replacements on assistant messages become text blocks', () => {
    const manager = SessionManager.inMemory();
    const targetId = manager.appendMessage(
      assistantMessage('original assistant text'),
    );
    manager.appendContextEdit(targetId, 'replacement');

    const context = manager.buildSessionContext();
    const assistant = context.messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    if (assistant?.role === 'assistant') {
      expect(assistant.content).toEqual([
        { type: 'text', text: 'replacement' },
      ]);
    }
  });

  it('later edit for the same target wins; edits before their target do not apply', () => {
    const manager = SessionManager.inMemory();
    const targetId = manager.appendMessage(userMessage('original'));
    manager.appendContextEdit(targetId, 'first replacement');
    manager.appendContextEdit(targetId, null);

    const context = manager.buildSessionContext();
    expect(context.messages).toHaveLength(0);
  });

  it('retain-none compaction keeps only post-compaction messages', () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage(userMessage('old'));
    manager.appendMessage(userMessage('also old'));
    manager.appendCompaction('summary of everything', null, 1000);
    const afterId = manager.appendMessage(userMessage('after compaction'));

    const context = manager.buildSessionContext();
    // Summary message + only the post-compaction message.
    expect(context.messages).toHaveLength(2);
    expect(lastUserText(context.messages)).toBe('after compaction');
    expect(afterId).toBeTruthy();
  });

  it('message appended after an edit for another target is unaffected', () => {
    const manager = SessionManager.inMemory();
    const a = manager.appendMessage(userMessage('a'));
    manager.appendContextEdit(a, null);
    manager.appendMessage(userMessage('b'));

    const context = manager.buildSessionContext();
    expect(context.messages).toHaveLength(1);
    expect(lastUserText(context.messages)).toBe('b');
  });
});
