import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchTrace, fetchTraces } from './traces';

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('trace API parsing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts unknown future status strings and fills optional counters', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          success: true,
          data: [{ traceId: 'run-1', status: 'queued-remotely' }],
        }),
      ),
    );

    await expect(fetchTraces()).resolves.toEqual([
      expect.objectContaining({
        traceId: 'run-1',
        status: 'queued-remotely',
        modelStepCount: 0,
        toolCount: 0,
      }),
    ]);
  });

  it('degrades a malformed list response to an empty list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ success: true, data: 'not-an-array' })),
    );

    await expect(fetchTraces()).resolves.toEqual([]);
  });

  it('degrades a malformed detail response to null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ success: true, data: { events: [] } })),
    );

    await expect(fetchTrace('run-1')).resolves.toBeNull();
  });
});
