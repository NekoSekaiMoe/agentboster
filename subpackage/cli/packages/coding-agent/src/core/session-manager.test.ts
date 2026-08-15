import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@agentboster-cli/agent';
import {
  buildSessionContext,
  type SessionEntry,
  sessionEntryToContextMessages,
} from './session-manager.ts';

const TS = '2026-01-01T00:00:00.000Z';

function userMessage(text: string): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.parse(TS),
  } as AgentMessage;
}

function messageEntry(
  id: string,
  parentId: string | null,
  message: AgentMessage,
): SessionEntry {
  return { type: 'message', id, parentId, timestamp: TS, message };
}

describe('sessionEntryToContextMessages', () => {
  it('converts null message content to an empty array', () => {
    // Session files are parsed without validation; old versions, forks, or
    // hand-edited files can contain messages with null/missing content.
    const malformed = {
      role: 'assistant',
      content: null,
      timestamp: Date.parse(TS),
    } as unknown as AgentMessage;
    const [converted] = sessionEntryToContextMessages(
      messageEntry('e1', null, malformed),
    );
    expect(converted.role).toBe('assistant');
    expect((converted as { content: unknown }).content).toEqual([]);
  });

  it('converts missing custom_message content to an empty array', () => {
    const entry = {
      type: 'custom_message',
      id: 'c1',
      parentId: null,
      timestamp: TS,
      customType: 'x-report',
      display: false,
      // content intentionally missing (malformed session data)
    } as unknown as SessionEntry;
    const [converted] = sessionEntryToContextMessages(entry);
    expect(converted.role).toBe('custom');
    expect((converted as { content: unknown }).content).toEqual([]);
  });
});

describe('buildSessionContext', () => {
  it('normalizes malformed entries the same way as sessionEntryToContextMessages', () => {
    const malformedAssistant = {
      role: 'assistant',
      content: null,
      timestamp: Date.parse(TS),
    } as unknown as AgentMessage;
    const entries: SessionEntry[] = [
      messageEntry('m1', null, userMessage('hello')),
      messageEntry('m2', 'm1', malformedAssistant),
      {
        type: 'custom_message',
        id: 'c1',
        parentId: 'm2',
        timestamp: TS,
        customType: 'x-report',
        display: false,
      } as unknown as SessionEntry,
    ];
    const { messages } = buildSessionContext(entries);
    expect(messages).toHaveLength(3);
    expect(messages[1].role).toBe('assistant');
    expect((messages[1] as { content: unknown }).content).toEqual([]);
    expect(messages[2].role).toBe('custom');
    expect((messages[2] as { content: unknown }).content).toEqual([]);
  });

  it('emits only the latest compaction summary when a path crosses multiple compactions', () => {
    const entries: SessionEntry[] = [
      messageEntry('m1', null, userMessage('first')),
      {
        type: 'compaction',
        id: 'c1',
        parentId: 'm1',
        timestamp: TS,
        summary: 'old summary',
        firstKeptEntryId: 'm2',
        tokensBefore: 100,
      },
      messageEntry('m2', 'c1', userMessage('kept')),
      {
        type: 'compaction',
        id: 'c2',
        parentId: 'm2',
        timestamp: TS,
        summary: 'latest summary',
        // Kept range starts before the older compaction entry, so c1 sits on
        // the emitted path and must NOT re-emit its own summary.
        firstKeptEntryId: 'm1',
        tokensBefore: 200,
      },
      messageEntry('m3', 'c2', userMessage('after')),
    ];
    const { messages } = buildSessionContext(entries);
    const summaries = messages.filter((m) => m.role === 'compactionSummary');
    expect(summaries).toHaveLength(1);
    expect((summaries[0] as { summary: string }).summary).toBe(
      'latest summary',
    );
    // Order: latest summary, kept messages (m1, m2), then after-compaction m3.
    expect(messages.map((m) => m.role)).toEqual([
      'compactionSummary',
      'user',
      'user',
      'user',
    ]);
  });
});
