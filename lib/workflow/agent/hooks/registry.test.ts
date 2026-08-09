/**
 * Tests for the workflow hook registry.
 *
 * Pure in-memory pub/sub with priority ordering. Covers registration
 * ordering (descending priority; stable among ties), the unsubscribe
 * function returned by register(), the before-hook chaining semantics
 * (each handler can transform the payload and the chain sees the new
 * value; undefined means "keep previous"), the after-hook fan-out
 * (concurrent, errors swallowed), and before-hook error propagation.
 */

import { describe, expect, it } from 'vitest';
import { HookRegistry } from './registry';
import type { HookContext } from './types';

function ctx(): HookContext {
  return {
    sessionId: 's1',
    runId: 'r1',
    agentName: 'main',
    appConfig: {} as HookContext['appConfig'],
  };
}

describe('HookRegistry — register / priority ordering', () => {
  it('evaluates hooks in descending priority order', async () => {
    const registry = new HookRegistry();
    const order: string[] = [];
    registry.register({
      id: 'low',
      node: 'beforeToolCall',
      priority: 1,
      handler: async () => {
        order.push('low');
      },
    } as never);
    registry.register({
      id: 'high',
      node: 'beforeToolCall',
      priority: 100,
      handler: async () => {
        order.push('high');
      },
    } as never);

    await registry.executeBefore('beforeToolCall', makePayload(), ctx());
    expect(order).toEqual(['high', 'low']);
  });

  it('register returns an unsubscribe that removes only that hook', async () => {
    const registry = new HookRegistry();
    const order: string[] = [];
    const unsub = registry.register({
      id: 'a',
      node: 'beforeToolCall',
      priority: 1,
      handler: async () => {
        order.push('a');
      },
    } as never);
    registry.register({
      id: 'b',
      node: 'beforeToolCall',
      priority: 1,
      handler: async () => {
        order.push('b');
      },
    } as never);

    unsub();
    await registry.executeBefore('beforeToolCall', makePayload(), ctx());
    expect(order).toEqual(['b']);
  });

  it('unsubscribe is idempotent (calling twice is a no-op)', async () => {
    const registry = new HookRegistry();
    let calls = 0;
    const unsub = registry.register({
      id: 'a',
      node: 'beforeToolCall',
      priority: 1,
      handler: async () => {
        calls += 1;
      },
    } as never);
    unsub();
    unsub();
    await registry.executeBefore('beforeToolCall', makePayload(), ctx());
    expect(calls).toBe(0);
  });

  it('hooks registered for a different node do not fire', async () => {
    const registry = new HookRegistry();
    let called = false;
    registry.register({
      id: 'x',
      node: 'afterStepFinish',
      priority: 1,
      handler: async () => {
        called = true;
      },
    } as never);
    await registry.executeBefore('beforeToolCall', makePayload(), ctx());
    expect(called).toBe(false);
  });
});

describe('HookRegistry — executeBefore chaining', () => {
  it('threads the payload through each handler in order', async () => {
    const registry = new HookRegistry();
    registry.register({
      id: 'add1',
      node: 'beforeToolCall',
      priority: 10,
      handler: async (payload: any) => {
        return { ...payload, input: { n: (payload.input.n as number) + 1 } };
      },
    } as never);
    registry.register({
      id: 'double',
      node: 'beforeToolCall',
      priority: 5,
      handler: async (payload: any) => {
        return { ...payload, input: { n: (payload.input.n as number) * 2 } };
      },
    } as never);

    const result = await registry.executeBefore(
      'beforeToolCall',
      makePayload({ n: 3 }),
      ctx(),
    );
    // (3 + 1) * 2 = 8
    expect(result.input.n).toBe(8);
  });

  it('a handler returning undefined keeps the previous payload', async () => {
    const registry = new HookRegistry();
    registry.register({
      id: 'noop',
      node: 'beforeToolCall',
      priority: 10,
      handler: async () => undefined,
    } as never);
    registry.register({
      id: 'mutate',
      node: 'beforeToolCall',
      priority: 5,
      handler: async (payload: any) => {
        return { ...payload, input: { n: 99 } };
      },
    } as never);

    const result = await registry.executeBefore(
      'beforeToolCall',
      makePayload({ n: 1 }),
      ctx(),
    );
    expect(result.input.n).toBe(99);
  });

  it('returns the payload unchanged when no hooks are registered', async () => {
    const registry = new HookRegistry();
    const payload = makePayload({ n: 5 });
    const result = await registry.executeBefore(
      'beforeToolCall',
      payload,
      ctx(),
    );
    expect(result).toBe(payload);
  });
});

describe('HookRegistry — error behavior', () => {
  it('executeBefore rethrows when a handler throws', async () => {
    const registry = new HookRegistry();
    registry.register({
      id: 'boom',
      node: 'beforeToolCall',
      priority: 10,
      handler: async () => {
        throw new Error('boom');
      },
    } as never);
    await expect(
      registry.executeBefore('beforeToolCall', makePayload(), ctx()),
    ).rejects.toThrow('boom');
  });

  it('executeAfter swallows handler errors (best-effort fan-out)', async () => {
    const registry = new HookRegistry();
    let otherRan = false;
    registry.register({
      id: 'boom',
      node: 'afterToolCall',
      priority: 10,
      handler: async () => {
        throw new Error('boom');
      },
    } as never);
    registry.register({
      id: 'ok',
      node: 'afterToolCall',
      priority: 5,
      handler: async () => {
        otherRan = true;
      },
    } as never);
    // Does not throw.
    await registry.executeAfter('afterToolCall', makePayload(), ctx());
    expect(otherRan).toBe(true);
  });
});

// Helper: a minimal BeforeToolCallPayload-shaped object. The registry
// is generically typed; using a plain record keeps the test independent
// of the exact payload schema.
function makePayload(input: Record<string, unknown> = {}): any {
  return { toolName: 't', toolId: 't1', input };
}
