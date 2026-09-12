import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolExecutionOptions } from 'ai';

const getSpillMock = vi.hoisted(() => vi.fn());

vi.mock('./store', () => ({
  getSpill: getSpillMock,
  putSpill: vi.fn(),
}));

import spillFetchTool from './fetch';
import type { BuildInToolFactoryContext } from '../define';
import type { StoredSpill } from './core';

function factoryContext(sessionId: string): BuildInToolFactoryContext {
  return {
    sessionId,
    runId: 'run-1',
    agentName: 'main',
    allowDelegation: true,
    // Only sessionId matters to this tool; the rest satisfies the type.
  } as unknown as BuildInToolFactoryContext;
}

function record(overrides: Partial<StoredSpill> = {}): StoredSpill {
  return {
    text: 'a'.repeat(500),
    totalChars: 500,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function buildExecute(sessionId: string) {
  const tools = await spillFetchTool.factory({}, factoryContext(sessionId));
  if (!tools) throw new Error('factory returned no tools');
  const execute = tools.fetch_spilled_output?.execute;
  if (!execute) throw new Error('fetch_spilled_output has no execute');
  return execute as (
    input: { spillId: string; offset?: number; length?: number },
    options: ToolExecutionOptions,
  ) => Promise<Record<string, unknown>>;
}

const execOpts = {
  toolCallId: 'call-1',
  messages: [],
} as ToolExecutionOptions;

describe('fetch_spilled_output', () => {
  beforeEach(() => {
    getSpillMock.mockReset();
  });

  it('scopes reads to the registering session', async () => {
    getSpillMock.mockResolvedValue(record({ sessionId: 'sess-1' }));
    const execute = await buildExecute('sess-1');
    const result = (await execute({ spillId: 'call-big' }, execOpts)) as {
      ok: boolean;
      text: string;
    };
    expect(getSpillMock).toHaveBeenCalledWith('call-big', 'sess-1');
    expect(result.ok).toBe(true);
    // Default page (4k preview chars) is clamped to the 500 stored chars.
    expect(result.text?.length).toBe(500);
  });

  it('reports foreign or missing records as not found', async () => {
    getSpillMock.mockResolvedValue(null);
    const execute = await buildExecute('sess-1');
    const result = (await execute({ spillId: 'call-foreign' }, execOpts)) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No stored output');
  });

  it('reports original totalChars and store truncation separately', async () => {
    // Store kept a 500-char prefix of a 1000-char output.
    getSpillMock.mockResolvedValue(
      record({ text: 'a'.repeat(500), totalChars: 1000, sessionId: 's' }),
    );
    const execute = await buildExecute('s');
    const result = (await execute(
      { spillId: 'call-trunc', offset: 0, length: 200 },
      execOpts,
    )) as {
      totalChars: number;
      storedChars: number;
      truncatedInStore: boolean;
      hasMore: boolean;
      length: number;
    };
    // totalChars keeps the ORIGINAL length; paging is bounded by what was
    // actually stored, so truncation stays visible instead of silently
    // redefining the total.
    expect(result.totalChars).toBe(1000);
    expect(result.storedChars).toBe(500);
    expect(result.truncatedInStore).toBe(true);
    expect(result.length).toBe(200);
    expect(result.hasMore).toBe(true); // 200 < 500 stored
  });

  it('marks the final page with hasMore=false (against stored length)', async () => {
    getSpillMock.mockResolvedValue(
      record({ text: 'a'.repeat(500), totalChars: 500, sessionId: 's' }),
    );
    const execute = await buildExecute('s');
    const result = (await execute(
      { spillId: 'call-tail', offset: 400, length: 200 },
      execOpts,
    )) as { length: number; hasMore: boolean };
    expect(result.length).toBe(100); // clamped to stored length
    expect(result.hasMore).toBe(false);
  });
});
