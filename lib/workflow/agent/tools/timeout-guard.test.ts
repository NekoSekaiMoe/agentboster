import { describe, expect, it, vi } from 'vitest';
import type { ToolSet } from 'ai';
import {
  resolveToolTimeoutMs,
  TOOL_TIMEOUT,
  withToolTimeout,
} from './timeout-guard';

function makeTool(execute: ToolSet[string]['execute']): ToolSet[string] {
  return {
    id: 'test.tool',
    description: 'test',
    inputSchema: undefined,
    execute,
  } as unknown as ToolSet[string];
}

function opts(signal?: AbortSignal) {
  return { toolCallId: 'call-1', messages: [], abortSignal: signal };
}

describe('resolveToolTimeoutMs', () => {
  it('returns undefined without config or env', () => {
    expect(resolveToolTimeoutMs(undefined, {})).toBeUndefined();
  });

  it('prefers tool entry config over env', () => {
    expect(
      resolveToolTimeoutMs(
        { timeoutMs: '5000' },
        {
          AGENT_TOOL_DEFAULT_TIMEOUT_MS: '9000',
        },
      ),
    ).toBe(5000);
  });

  it('falls back to env', () => {
    expect(
      resolveToolTimeoutMs(undefined, {
        AGENT_TOOL_DEFAULT_TIMEOUT_MS: '9000',
      }),
    ).toBe(9000);
  });

  it('rejects invalid, zero, and negative values (fail to no-budget)', () => {
    expect(resolveToolTimeoutMs({ timeoutMs: 'abc' }, {})).toBeUndefined();
    expect(resolveToolTimeoutMs({ timeoutMs: '0' }, {})).toBeUndefined();
    expect(resolveToolTimeoutMs({ timeoutMs: '-5' }, {})).toBeUndefined();
  });
});

describe('withToolTimeout', () => {
  it('returns the tool unchanged when there is no budget', async () => {
    const tool = makeTool(async () => ({ ok: true }));
    expect(withToolTimeout(tool, {})).toBe(tool);
  });

  it('returns the tool unchanged when it has no execute', () => {
    const tool = {} as ToolSet[string];
    expect(withToolTimeout(tool, { timeoutMs: 100 })).toBe(tool);
  });

  it('replaces the result with a structured TOOL_TIMEOUT when its own timer fires', async () => {
    const tool = withToolTimeout(
      makeTool(() => new Promise(() => undefined)), // never settles
      { timeoutMs: 10 },
    );
    const result = await tool.execute?.({}, opts());
    expect(result).toEqual({
      ok: false,
      code: TOOL_TIMEOUT,
      timedOut: true,
      error: 'Error: tool call timed out after 10ms',
      timeoutMs: 10,
    });
  });

  it('passes through a result that settles before the deadline', async () => {
    const tool = withToolTimeout(
      makeTool(async () => ({ ok: true, value: 42 })),
      { timeoutMs: 10_000 },
    );
    await expect(tool.execute?.({}, opts())).resolves.toEqual({
      ok: true,
      value: 42,
    });
  });

  it('propagates rejections that happen before the deadline', async () => {
    const tool = withToolTimeout(
      makeTool(async () => {
        throw new Error('boom');
      }),
      { timeoutMs: 10_000 },
    );
    await expect(tool.execute?.({}, opts())).rejects.toThrow('boom');
  });

  it('reports upstream cancellation as the tool own error, never as TOOL_TIMEOUT', async () => {
    // Tool rejects with an AbortError as soon as ITS signal aborts.
    const tool = withToolTimeout(
      makeTool(
        (_input, options) =>
          new Promise((_resolve, reject) => {
            options?.abortSignal?.addEventListener('abort', () => {
              const err = new Error('The run was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      ),
      { timeoutMs: 5_000 },
    );
    const upstream = new AbortController();
    const pending = tool.execute?.({}, opts(upstream.signal));
    upstream.abort();
    await expect(pending).rejects.toThrow('The run was aborted');
  });

  it('aborts the derived signal when its own timer fires (cooperative cancel)', async () => {
    let observedAbort = false;
    const tool = withToolTimeout(
      makeTool(
        (_input, options) =>
          new Promise((resolve) => {
            options?.abortSignal?.addEventListener('abort', () => {
              observedAbort = true;
              resolve({ ok: true, cancelled: true });
            });
          }),
      ),
      { timeoutMs: 10 },
    );
    const result = await tool.execute?.({}, opts());
    // Our timer fired, so the guard replaces the tool's post-abort return
    // value with the structured timeout result.
    expect(result).toMatchObject({ ok: false, code: TOOL_TIMEOUT });
    expect(observedAbort).toBe(true);
  });

  it('does not fire the timeout after the execute settles (no dangling timers)', async () => {
    vi.useFakeTimers();
    try {
      const tool = withToolTimeout(
        makeTool(async () => ({ ok: true })),
        {
          timeoutMs: 5_000,
        },
      );
      const result = await tool.execute?.({}, opts());
      expect(result).toEqual({ ok: true });
      vi.advanceTimersByTime(10_000); // would have fired if not disposed
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('review regressions (PR #63)', () => {
  it('rejects decimal and unit-suffixed budgets (whole-string validation)', () => {
    // parseInt would silently read these as 1 and 5000.
    expect(resolveToolTimeoutMs({ timeoutMs: '1.5' }, {})).toBeUndefined();
    expect(resolveToolTimeoutMs({ timeoutMs: '5000ms' }, {})).toBeUndefined();
    expect(resolveToolTimeoutMs({ timeoutMs: '0.5' }, {})).toBeUndefined();
  });

  it('reports upstream abort immediately when the tool ignores the signal', async () => {
    // Tool ignores the derived signal and never settles. The budget is
    // deliberately long: a TOOL_TIMEOUT outcome here would prove we waited
    // for the local timer and mislabeled the upstream cancellation.
    const tool = withToolTimeout(
      makeTool(() => new Promise(() => undefined)),
      { timeoutMs: 60_000 },
    );
    const upstream = new AbortController();
    const pending = tool.execute?.({}, opts(upstream.signal));
    upstream.abort();
    await expect(pending).rejects.toThrow('Tool execution aborted upstream');
  });

  it('rejects immediately when the upstream signal is already aborted', async () => {
    const tool = withToolTimeout(
      makeTool(() => new Promise(() => undefined)),
      { timeoutMs: 60_000 },
    );
    const upstream = new AbortController();
    upstream.abort();
    await expect(tool.execute?.({}, opts(upstream.signal))).rejects.toThrow(
      'Tool execution aborted upstream',
    );
  });

  it('passes through a tool that legitimately resolves `true`', async () => {
    // A bare `true` used to collide with the timeout sentinel.
    const tool = withToolTimeout(
      makeTool(async () => true as never),
      { timeoutMs: 10_000 },
    );
    await expect(tool.execute?.({}, opts())).resolves.toBe(true);
  });
});
