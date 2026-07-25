import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import {
  applyMessageCompat,
  resolveProviderCompat,
  type ProviderCompat,
} from './provider-compat';

// Helpers to build minimal ModelMessage-shaped objects. We only exercise the
// fields the compat layer reads (role + content parts with type/toolCallId).
function assistant(parts: unknown[]): ModelMessage {
  return { role: 'assistant', content: parts } as unknown as ModelMessage;
}
function user(text: string): ModelMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
  } as unknown as ModelMessage;
}
function toolMsg(toolCallId: string, output = 'ok'): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId, output }],
  } as unknown as ModelMessage;
}
function call(id: string): unknown {
  return { type: 'tool-call', toolCallId: id, toolName: 't', input: {} };
}
function text(text: string): unknown {
  return { type: 'text', text };
}

const ALL_OFF: ProviderCompat = {
  mergeAssistantMessages: false,
  cleanOrphanToolResults: false,
  cleanOrphanToolCalls: false,
  dedupToolResults: false,
  ensureAlternation: false,
  mergeSameRole: false,
};

describe('resolveProviderCompat', () => {
  it('anthropic defaults: alternation + same-role merge + orphan results', () => {
    const c = resolveProviderCompat('anthropic');
    expect(c.ensureAlternation).toBe(true);
    expect(c.mergeSameRole).toBe(true);
    expect(c.cleanOrphanToolResults).toBe(true);
    expect(c.cleanOrphanToolCalls).toBe(false);
  });

  it('openai defaults: assistant merge + orphan cleanup + dedup', () => {
    const c = resolveProviderCompat('openai');
    expect(c.mergeAssistantMessages).toBe(true);
    expect(c.cleanOrphanToolCalls).toBe(true);
    expect(c.cleanOrphanToolResults).toBe(true);
    expect(c.dedupToolResults).toBe(true);
    expect(c.ensureAlternation).toBe(false);
  });

  it('openaicompatible: every repair enabled (most fragile)', () => {
    const c = resolveProviderCompat('openaicompatible');
    expect(c.mergeAssistantMessages).toBe(true);
    expect(c.cleanOrphanToolCalls).toBe(true);
    expect(c.cleanOrphanToolResults).toBe(true);
    expect(c.dedupToolResults).toBe(true);
    expect(c.ensureAlternation).toBe(true);
    expect(c.mergeSameRole).toBe(true);
  });

  it('user overrides win per-flag', () => {
    const c = resolveProviderCompat('openai', {
      merge_assistant_messages: false,
      ensure_alternation: true,
    });
    expect(c.mergeAssistantMessages).toBe(false);
    expect(c.ensureAlternation).toBe(true);
    // untouched flags keep openai defaults
    expect(c.cleanOrphanToolCalls).toBe(true);
  });
});

describe('applyMessageCompat', () => {
  it('noop when every flag off returns same array', () => {
    const msgs = [user('hi'), assistant([text('hello')])];
    const out = applyMessageCompat(msgs, ALL_OFF);
    expect(out).toBe(msgs); // identity
  });

  it('merges consecutive assistant messages', () => {
    const msgs = [
      user('hi'),
      assistant([text('a')]),
      assistant([text('b')]),
      assistant([text('c')]),
    ];
    const out = applyMessageCompat(msgs, {
      ...ALL_OFF,
      mergeAssistantMessages: true,
    });
    expect(out).toHaveLength(2);
    expect(out[1]?.role).toBe('assistant');
    expect(out[1]?.content as unknown[]).toHaveLength(3);
  });

  it('does not merge across roles', () => {
    const msgs = [
      assistant([text('a')]),
      user('interrupt'),
      assistant([text('b')]),
    ];
    const out = applyMessageCompat(msgs, {
      ...ALL_OFF,
      mergeAssistantMessages: true,
    });
    expect(out).toHaveLength(3);
  });

  it('mergeSameRole collapses user+user too', () => {
    const msgs = [user('a'), user('b'), assistant([text('r')])];
    const out = applyMessageCompat(msgs, {
      ...ALL_OFF,
      mergeSameRole: true,
    });
    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe('user');
    expect(out[0]?.content as unknown[]).toHaveLength(2);
  });

  it('strips orphan tool calls (assistant tool-call with no result)', () => {
    const msgs = [
      user('go'),
      assistant([call('c1'), text('done')]), // c1 has no result
    ];
    const out = applyMessageCompat(msgs, {
      ...ALL_OFF,
      cleanOrphanToolCalls: true,
    });
    expect(out).toHaveLength(2);
    // assistant keeps its text part, drops the orphan call
    expect(out[1]?.content as unknown[]).toEqual([text('done')]);
  });

  it('keeps tool calls that have matching results', () => {
    const msgs = [user('go'), assistant([call('c1')]), toolMsg('c1')];
    const out = applyMessageCompat(msgs, {
      ...ALL_OFF,
      cleanOrphanToolCalls: true,
    });
    expect(out).toHaveLength(3);
    expect(out[1]?.content as unknown[]).toEqual([call('c1')]);
  });

  it('strips orphan tool results (result with no call)', () => {
    const msgs = [
      user('go'),
      assistant([text('hi')]),
      toolMsg('ghost'), // no matching call
    ];
    const out = applyMessageCompat(msgs, {
      ...ALL_OFF,
      cleanOrphanToolResults: true,
    });
    // ghost tool message fully dropped
    expect(out).toHaveLength(2);
    expect(out.some((m) => m.role === 'tool')).toBe(false);
  });

  it('dedups duplicate tool results keeping last', () => {
    const msgs = [
      assistant([call('c1')]),
      toolMsg('c1', 'first'),
      toolMsg('c1', 'second'),
    ];
    const out = applyMessageCompat(msgs, {
      ...ALL_OFF,
      dedupToolResults: true,
    });
    const toolMessages = out.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    const parts = toolMessages[0]!.content as unknown as { output: string }[];
    expect(parts[0]?.output).toBe('second');
  });

  it('enforces alternation by inserting filler user turn', () => {
    const msgs = [assistant([text('a')]), assistant([text('b')])];
    const out = applyMessageCompat(msgs, {
      ...ALL_OFF,
      ensureAlternation: true,
    });
    expect(out).toHaveLength(3);
    expect(out[1]?.role).toBe('user');
    expect(out[2]?.role).toBe('assistant');
  });

  it('tool messages count as user-side for alternation', () => {
    const msgs = [
      user('go'),
      assistant([call('c1')]),
      toolMsg('c1'),
      assistant([text('r')]),
    ];
    const out = applyMessageCompat(msgs, {
      ...ALL_OFF,
      ensureAlternation: true,
    });
    // already alternating (user, assistant, tool=user, assistant) -> unchanged
    expect(out).toHaveLength(4);
  });

  it('full openaicompatible pipeline repairs a messy history', () => {
    const compat = resolveProviderCompat('openaicompatible');
    const msgs = [
      user('go'),
      assistant([call('c1'), text('thinking')]),
      assistant([call('c1')]), // dup call, merged into prev assistant
      toolMsg('c1', 'first'),
      toolMsg('c1', 'second'), // dup result, dedup keeps last
      assistant([text('r'), call('orphan')]), // orphan call has no result
    ];
    const out = applyMessageCompat(msgs, compat);
    // Expect: user, assistant(merged, orphan stripped), tool(deduped), assistant(text only)
    const roles = out.map((m) => m.role);
    // After orphan cleanup the last assistant should keep only its text part.
    const lastAssistant = [...out]
      .reverse()
      .find((m) => m.role === 'assistant');
    expect(lastAssistant?.content as unknown[]).toContainEqual(text('r'));
    const lastAssistantContent = lastAssistant?.content as
      | unknown[]
      | undefined;
    expect(
      lastAssistantContent?.some(
        (p) => (p as { toolCallId?: string }).toolCallId === 'orphan',
      ),
    ).toBe(false);
    // No duplicate tool results survived
    const toolResults = out.filter((m) => m.role === 'tool');
    expect(toolResults).toHaveLength(1);
    // Sanity: roles are a valid prefix
    expect(roles[0]).toBe('user');
    expect(roles.includes('assistant')).toBe(true);
  });

  it('does not mutate input', () => {
    const msgs = [user('hi'), assistant([text('a')]), assistant([text('b')])];
    const snapshot = JSON.parse(JSON.stringify(msgs));
    applyMessageCompat(msgs, { ...ALL_OFF, mergeAssistantMessages: true });
    expect(msgs).toEqual(snapshot);
  });
});
