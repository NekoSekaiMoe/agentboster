import { describe, it, expect, vi } from 'vitest';
import type { ExtensionAPI } from '../../core/extensions/index.ts';
import { observeTargets } from './observation.ts';

/**
 * Minimal ExtensionAPI stand-in: registerBashBg only touches registerTool,
 * events, sendMessage, and the session_start/session_compact/session_shutdown
 * handlers, so a partial mock is enough to drive the tool end-to-end.
 */
function makeApi(): {
  api: ExtensionAPI;
  tools: Map<string, any>;
  messages: Array<{ customType: string; content: string }>;
  handlers: Map<string, (data: unknown) => void | Promise<void>>;
} {
  const tools = new Map<string, any>();
  const messages: Array<{ customType: string; content: string }> = [];
  const handlers = new Map<string, (data: unknown) => void | Promise<void>>();
  const api = {
    registerTool: vi.fn((tool: any) => {
      tools.set(tool.name, tool);
    }),
    registerCommand: vi.fn(),
    events: {
      emit: vi.fn(),
      on: vi.fn((_channel: string, handler: (data: unknown) => void) => {
        handlers.set(_channel, handler);
        return () => handlers.delete(_channel);
      }),
    },
    sendMessage: vi.fn((message: { customType: string; content: string }) => {
      messages.push(message);
    }),
    on: vi.fn(),
  } as unknown as ExtensionAPI;
  return { api, tools, messages, handlers };
}

describe('smart-flow bash_bg', () => {
  it('runs a fast command inline via action=run', async () => {
    const { api, tools } = makeApi();
    const { registerBashBg } = await import('./bash-bg.ts');
    registerBashBg(api);
    const tool = tools.get('bash_bg');

    const result = await tool.execute(
      't1',
      { action: 'run', command: 'echo hello', timeout: 10 },
      undefined,
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('hello');
    expect(text).toContain('(exit 0)');
    expect(result.details.jobId).toMatch(/^bg-/);
  });

  it('auto-backgrounds a slow command and notifies on completion', async () => {
    const { api, tools, messages } = makeApi();
    const { registerBashBg } = await import('./bash-bg.ts');
    registerBashBg(api);
    const tool = tools.get('bash_bg');

    const result = await tool.execute(
      't2',
      { action: 'run', command: 'sleep 5', timeout: 1 },
      undefined,
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('moved to background');
    const jobId = result.details.jobId as string;
    expect(jobId).toMatch(/^bg-/);

    // Wait for the background job to complete and trigger the notification.
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    const complete = messages.find((m) => m.customType === 'bash-bg-complete');
    expect(complete).toBeDefined();
    expect(complete?.content).toContain(jobId);
  }, 15_000);

  it('lists jobs and reports unknown jobIds', async () => {
    const { api, tools } = makeApi();
    const { registerBashBg } = await import('./bash-bg.ts');
    registerBashBg(api);
    const tool = tools.get('bash_bg');

    const list = await tool.execute('t3', { action: 'list' }, undefined);
    expect((list.content[0] as { text: string }).text).toContain(
      'No background jobs',
    );

    await expect(
      tool.execute('t4', { action: 'status', jobId: 'nope' }, undefined),
    ).rejects.toThrow('Unknown jobId');
  });
});

describe('smart-flow observe', () => {
  it('reports not-found for unknown providers without throwing', async () => {
    const result = await observeTargets({
      action: 'status',
      targets: [{ kind: 'no-such-kind', id: 'x' }],
    });
    expect(result.reason).toBe('snapshot');
    expect(result.observations[0].found).toBe(false);
    expect(result.observations[0].waitStatus).toBe('not-found');
  });

  it('validates targets', async () => {
    await expect(
      observeTargets({ action: 'status', targets: [] }),
    ).rejects.toThrow('at least one target');
  });
});
