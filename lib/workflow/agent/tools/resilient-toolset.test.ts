import type { ToolSet } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@/lib/utils/logger';
import { createResilientToolSet } from './index';

type RealTool = ToolSet[string];
type ExecuteFn = NonNullable<RealTool['execute']>;

/**
 * Build a minimal real tool for tests. We intentionally construct the
 * tool object directly (bypassing ai's `tool()` factory) so the test
 * stays decoupled from the factory's required-field schema and can
 * focus purely on the Proxy's interception behavior.
 */
function makeTool(execute: ExecuteFn): RealTool {
  return {
    type: 'function',
    description: 'test tool',
    inputSchema: undefined,
    execute,
  } as unknown as RealTool;
}

function makeRealTools() {
  const writeExecute = vi.fn().mockResolvedValue({ wrote: true });
  const readExecute = vi.fn().mockResolvedValue({ read: true });
  const tools: ToolSet = {
    writeMemory: makeTool(writeExecute as ExecuteFn),
    readMemory: makeTool(readExecute as ExecuteFn),
  };
  return { tools, writeExecute, readExecute };
}

const noopLogger = createLogger('test');

/** Shorthand to read any key off the Proxy without tripping biome's
 * useLiteralKeys rule (it only fires on `obj['literal']`). Using
 * Reflect.get also matches the semantic we are testing: dynamic
 * property lookup by string name. */
function get(proxy: ToolSet, name: string): RealTool {
  return Reflect.get(proxy, name) as RealTool;
}

/**
 * Invoke a real or fallback tool's execute, asserting it exists first.
 * Pulls the execute function out via a runtime check so we avoid the
 * `!` non-null assertion (which trips biome's noNonNullAssertion).
 */
async function run(
  proxy: ToolSet,
  name: string,
  input: unknown = {},
  toolCallId = 'c',
): Promise<unknown> {
  const tool = get(proxy, name);
  if (typeof tool.execute !== 'function') {
    throw new Error(`tool "${name}" has no execute`);
  }
  return tool.execute(
    input as never,
    {
      toolCallId,
      messages: [],
    } as never,
  );
}

describe('createResilientToolSet — enumeration (provider serialization surface)', () => {
  // These tests are the critical invariant: the Proxy must NOT leak
  // synthesized fallbacks into any enumeration path used by the ai SDK
  // to build the model-facing function_declarations array. If any of
  // these break, Gemini / OpenAI / Anthropic will see fallback names
  // (like '' or 'write_memory') in the tools list and may reject the
  // whole request.

  it('Object.keys returns exactly the real tool names', () => {
    const { tools } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    expect(Object.keys(proxy).sort()).toEqual(['readMemory', 'writeMemory']);
  });

  it('Object.entries returns exactly the real tools', () => {
    const { tools } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    const entries = Object.entries(proxy);
    expect(entries.length).toBe(2);
    expect(entries.map(([k]) => k).sort()).toEqual([
      'readMemory',
      'writeMemory',
    ]);
  });

  it('Object.values returns exactly the real tool objects', () => {
    const { tools } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    expect(Object.values(proxy).length).toBe(2);
  });

  it('Object.getOwnPropertyNames returns exactly the real tool names', () => {
    const { tools } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    expect(Object.getOwnPropertyNames(proxy).sort()).toEqual([
      'readMemory',
      'writeMemory',
    ]);
  });

  it('for...in only iterates real tools', () => {
    const { tools } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    const seen: string[] = [];
    for (const name in proxy) {
      seen.push(name);
    }
    expect(seen.sort()).toEqual(['readMemory', 'writeMemory']);
  });

  it('JSON.stringify only serializes real tools (no fallback clutter)', () => {
    const { tools } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    const json = JSON.stringify(proxy);
    expect(json).toContain('writeMemory');
    expect(json).toContain('readMemory');
    // The synthesized fallback names must not appear anywhere in the
    // serialized output — this is what the model would see if the Proxy
    // leaked ownKeys.
    expect(json).not.toContain('write_memory');
    expect(json).not.toContain('Internal fallback');
  });

  it('spreading ({...proxy}) copies only real tools', () => {
    const { tools } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    const spread = { ...proxy };
    expect(Object.keys(spread).sort()).toEqual(['readMemory', 'writeMemory']);
  });
});

describe('createResilientToolSet — interception', () => {
  it('returns the real tool when the name exists', () => {
    const { tools } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    expect(proxy.writeMemory).toBe(tools.writeMemory);
    expect(proxy.readMemory).toBe(tools.readMemory);
  });

  it('returns a truthy fallback for an unknown name', () => {
    const { tools } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    const fallback = get(proxy, 'totally_unknown_tool');
    expect(fallback).toBeDefined();
    expect(typeof fallback.execute).toBe('function');
  });

  it('returns a truthy fallback for the empty string key (regression guard)', () => {
    // The empty-string key was the original Gemini-rejection bug. The
    // Proxy must handle it without registering it as an enumerable
    // property — so it still gets a fallback, but Object.keys never
    // sees it.
    const { tools } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    const fallback = get(proxy, '');
    expect(fallback).toBeDefined();
    expect(typeof fallback.execute).toBe('function');
    expect(Object.keys(proxy)).not.toContain('');
  });

  it('does NOT synthesize a fallback for `then` (prevents thenable pollution)', () => {
    // If the Proxy returned a truthy value for `then`, JavaScript's
    // Promise resolution machinery would treat the Proxy as a thenable
    // and invoke `proxy.then(resolve, reject)` — silently derailing
    // any `await proxy` or `Promise.resolve(proxy)` in the ai SDK.
    const { tools } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    expect(proxy.then).toBeUndefined();
  });

  it('does NOT synthesize fallbacks for Symbol keys', () => {
    const sym = Symbol('test');
    const { tools } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    // Symbol keys must fall through to the target's normal property
    // lookup (returning undefined for unknown Symbols) — never a
    // fallback tool. Otherwise Reflect / iterator / async-iterator
    // protocols could be accidentally hooked.
    expect(Reflect.get(proxy, sym)).toBeUndefined();
  });

  it('"X in proxy" returns true for unknown string keys so the SDK reaches the get trap', () => {
    const { tools } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    expect(Reflect.has(proxy, 'totally_unknown_tool')).toBe(true);
    expect(Reflect.has(proxy, '')).toBe(true);
    expect(Reflect.has(proxy, 'writeMemory')).toBe(true);
  });

  it('"then in proxy" returns false (no thenable pollution via `in`)', () => {
    const { tools } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    expect(Reflect.has(proxy, 'then')).toBe(false);
  });
});

describe('createResilientToolSet — fallback resolution (alias forwarding)', () => {
  it('forwards snake_case alias to the canonical tool', async () => {
    const { tools, writeExecute } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    const result = await run(proxy, 'write_memory', { x: 1 }, 'call_1');

    expect(writeExecute).toHaveBeenCalledTimes(1);
    expect(writeExecute).toHaveBeenCalledWith(
      { x: 1 },
      expect.objectContaining({ toolCallId: 'call_1' }),
    );
    expect(result).toEqual({ wrote: true });
  });

  it('forwards kebab-case alias to the canonical tool', async () => {
    const { tools, readExecute } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    await run(proxy, 'read-memory');
    expect(readExecute).toHaveBeenCalledTimes(1);
  });

  it('forwards case-insensitive variant when unambiguous', async () => {
    const { tools, writeExecute } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    await run(proxy, 'WRITEMEMORY');
    expect(writeExecute).toHaveBeenCalledTimes(1);
  });
});

describe('createResilientToolSet — fallback resolution (edit-distance forwarding)', () => {
  it('forwards a single-character typo to the closest real tool', async () => {
    // writeMemorz — distance 1 from writeMemory
    const { tools, writeExecute } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    const result = (await run(proxy, 'writeMemorz')) as { wrote?: boolean };

    expect(writeExecute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ wrote: true });
  });

  it('forwards a single transposition to the closest real tool', async () => {
    // wrtieMemory — distance 2 from writeMemory
    const { tools, writeExecute } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    await run(proxy, 'wrtieMemory');
    expect(writeExecute).toHaveBeenCalledTimes(1);
  });

  it('does NOT forward when no real tool is within edit distance 2', async () => {
    const { tools, writeExecute, readExecute } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    const result = (await run(proxy, 'completelyUnrelatedToolName')) as {
      ok: boolean;
      error: string;
    };

    expect(writeExecute).not.toHaveBeenCalled();
    expect(readExecute).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
  });
});

describe('createResilientToolSet — structured error fallback', () => {
  it('returns a structured error with availableTools for an unknown name', async () => {
    const { tools } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    const result = (await run(proxy, 'nonexistent')) as {
      ok: boolean;
      error: string;
      suggestion: string | null;
      availableTools: string[];
      hint: string;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toContain('nonexistent');
    expect(Array.isArray(result.availableTools)).toBe(true);
    expect(result.availableTools.sort()).toEqual(['readMemory', 'writeMemory']);
    expect(typeof result.hint).toBe('string');
  });

  it('returns a structured error for the empty-string name', async () => {
    const { tools } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    const result = (await run(proxy, '')) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/empty/i);
  });
});

describe('createResilientToolSet — forward failure isolation', () => {
  it('returns a structured error (does NOT re-throw) when the canonical tool throws', async () => {
    const failingExecute = vi.fn().mockRejectedValue(new Error('disk full'));
    const tools: ToolSet = {
      writeMemory: makeTool(failingExecute as ExecuteFn),
    };
    const proxy = createResilientToolSet(tools, noopLogger);
    const result = (await run(proxy, 'write_memory')) as {
      ok: boolean;
      error: string;
    };

    expect(failingExecute).toHaveBeenCalledTimes(1);
    // Critical: the error must be contained as a structured result, NOT
    // re-thrown. A re-throw here would be caught by DurableAgent's
    // executeTool catch block (which converts it to error-text), but
    // returning the structured error explicitly gives the model a
    // usable hint about which tool to retry with.
    expect(result.ok).toBe(false);
    expect(result.error).toContain('disk full');
  });
});

describe('createResilientToolSet — memoization', () => {
  it('returns the same fallback instance for the same requested name', () => {
    const { tools } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    const a = get(proxy, 'unknown_name');
    const b = get(proxy, 'unknown_name');
    expect(a).toBe(b);
  });

  it('returns distinct fallback instances for different requested names', () => {
    const { tools } = makeRealTools();
    const proxy = createResilientToolSet(tools, noopLogger);
    const a = get(proxy, 'first_unknown');
    const b = get(proxy, 'second_unknown');
    expect(a).not.toBe(b);
  });
});
