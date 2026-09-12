import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolExecutionOptions, ToolSet } from 'ai';

const putSpillMock = vi.hoisted(() => vi.fn());

vi.mock('./store', () => ({
  putSpill: putSpillMock,
  getSpill: vi.fn(),
}));

import { withToolResultSpill } from './wrap';
import { resolveSpillSettings } from './core';

function makeTool(execute: ToolSet[string]['execute']): ToolSet[string] {
  return {
    id: 'test.tool',
    description: 'test',
    inputSchema: undefined,
    execute,
  } as unknown as ToolSet[string];
}

function opts(toolCallId?: string): ToolExecutionOptions {
  // The SDK always supplies a toolCallId at runtime; the undefined case
  // exercises the wrapper's defensive branch, hence the cast.
  return {
    messages: [],
    ...(toolCallId ? { toolCallId } : {}),
  } as ToolExecutionOptions;
}

describe('withToolResultSpill', () => {
  beforeEach(() => {
    putSpillMock.mockReset();
    delete process.env.AGENT_TOOL_SPILL_THRESHOLD_CHARS;
    delete process.env.AGENT_TOOL_SPILL_DISABLED;
  });

  it('passes small results through untouched without storage', async () => {
    const tool = withToolResultSpill(
      makeTool(async () => ({ ok: true, small: 'yes' })),
    );
    const result = await tool.execute?.({ x: 1 }, opts('call-1'));
    expect(result).toEqual({ ok: true, small: 'yes' });
    expect(putSpillMock).not.toHaveBeenCalled();
  });

  it('spills oversized results with a locator keyed by toolCallId', async () => {
    const bigText = 'z'.repeat(60_000);
    const tool = withToolResultSpill(
      makeTool(async () => ({ ok: true, data: bigText })),
    );
    const result = (await tool.execute?.({}, opts('call-big'))) as {
      spilled: boolean;
      spillId: string;
      totalChars: number;
      preview: string;
    };

    // The model-visible replacement…
    expect(result.spilled).toBe(true);
    expect(result.spillId).toBe('call-big');
    expect(result.preview.length).toBeLessThanOrEqual(5000);
    // …and the full text was stored with the configured TTL.
    const settings = resolveSpillSettings({});
    expect(putSpillMock).toHaveBeenCalledTimes(1);
    const [spillId, record, ttl] = putSpillMock.mock.calls[0];
    expect(spillId).toBe('call-big');
    expect(record.text.length).toBeGreaterThan(59_000);
    expect(record.totalChars).toBeGreaterThanOrEqual(60_000);
    expect(ttl).toBe(settings.ttlSeconds);
  });

  it('returns the original result when storage fails (degradation, not regression)', async () => {
    putSpillMock.mockRejectedValue(new Error('kv down'));
    const bigText = 'z'.repeat(60_000);
    const tool = withToolResultSpill(
      makeTool(async () => ({ ok: true, data: bigText })),
    );
    const result = await tool.execute?.({}, opts('call-fail'));
    // Original (oversized) result returned; persistence truncation applies.
    expect(result).toEqual({ ok: true, data: bigText });
  });

  it('skips spilling when there is no toolCallId', async () => {
    const bigText = 'z'.repeat(60_000);
    const tool = withToolResultSpill(
      makeTool(async () => ({ ok: true, data: bigText })),
    );
    const result = await tool.execute?.({}, opts(undefined));
    expect(result).toEqual({ ok: true, data: bigText });
    expect(putSpillMock).not.toHaveBeenCalled();
  });

  it('is disabled via env switch', async () => {
    process.env.AGENT_TOOL_SPILL_DISABLED = '1';
    const bigText = 'z'.repeat(60_000);
    const tool = withToolResultSpill(
      makeTool(async () => ({ ok: true, data: bigText })),
    );
    const result = await tool.execute?.({}, opts('call-x'));
    expect(result).toEqual({ ok: true, data: bigText });
    expect(putSpillMock).not.toHaveBeenCalled();
  });

  it('propagates execute rejections', async () => {
    const tool = withToolResultSpill(
      makeTool(async () => {
        throw new Error('boom');
      }),
    );
    await expect(tool.execute?.({}, opts('call-err'))).rejects.toThrow('boom');
  });

  it('binds spilled records to the owning session when provided', async () => {
    const bigText = 'z'.repeat(60_000);
    const tool = withToolResultSpill(
      makeTool(async () => ({ ok: true, data: bigText })),
      { sessionId: 'sess-1' },
    );
    await tool.execute?.({}, opts('call-owned'));
    const [, record] = putSpillMock.mock.calls[0] as [
      string,
      { sessionId?: string },
    ];
    expect(record.sessionId).toBe('sess-1');
  });

  it('omits the owner when no session context is available', async () => {
    const bigText = 'z'.repeat(60_000);
    const tool = withToolResultSpill(
      makeTool(async () => ({ ok: true, data: bigText })),
    );
    await tool.execute?.({}, opts('call-anon'));
    const [, record] = putSpillMock.mock.calls[0] as [
      string,
      { sessionId?: string },
    ];
    expect(record.sessionId).toBeUndefined();
  });

  it('returns tools without execute unchanged', () => {
    const tool = {} as ToolSet[string];
    expect(withToolResultSpill(tool)).toBe(tool);
  });
});
