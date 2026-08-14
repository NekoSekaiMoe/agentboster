import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';

const writeToolActivityLogs = vi.fn();

vi.mock('@/lib/core/db/agentd', () => ({
  writeToolActivityLogs,
}));

import { withToolExecutionLogger } from './define';

describe('workflow tool trace propagation', () => {
  beforeEach(() => {
    writeToolActivityLogs.mockReset();
  });

  it('persists the workflow run id as traceId for Web-hosted tools', async () => {
    const wrapped = withToolExecutionLogger(
      tool({
        inputSchema: z.object({ value: z.string() }),
        execute: async ({ value }) => ({ value }),
      }),
      {
        provider: 'builtin',
        toolId: 'memory',
        toolName: 'read',
        sessionId: '00000000-0000-0000-0000-000000000001',
        runId: 'run-workflow-1',
        agentName: 'main',
      },
    );

    await wrapped.execute?.(
      { value: 'key' },
      { toolCallId: 'call-1', messages: [] },
    );

    expect(writeToolActivityLogs).toHaveBeenCalledWith([
      expect.objectContaining({
        traceId: 'run-workflow-1',
        toolCallId: 'call-1',
        toolName: 'memory.read',
        success: true,
      }),
    ]);
  });
});
