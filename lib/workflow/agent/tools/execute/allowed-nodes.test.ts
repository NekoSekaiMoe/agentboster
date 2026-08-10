import type { AppConfig } from '@/types/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P3.1 allowed_nodes threading for the browser_* / desktop_* dispatchers.
 *
 * Both dispatchers forward to execToolOnAgentd, whose 5th argument is the
 * per-agent allowedNodes allowlist enforced against model-supplied nodeId
 * routing. These tests pin that the factories resolve the current agent's
 * `allowed_nodes` config and pass it through (previously a literal
 * `undefined`, which disabled the authorization check entirely).
 *
 * The dispatch functions are 'use step' but run inline on the host in
 * tests (see lib/workflow/agent/tools/agentd/nodes.test.ts for why that
 * is fine).
 */

const mockExecToolOnAgentd = vi.fn();
const mockIsAgentdAvailable = vi.fn();

vi.mock('@/lib/extra/agent/agentd-tools-client', () => ({
  execToolOnAgentd: mockExecToolOnAgentd,
}));

vi.mock('@/lib/workflow/agent/dispatch', () => ({
  isAgentdAvailable: mockIsAgentdAvailable,
}));

const { default: browserDefinition } = await import('./browser');
const { default: desktopDefinition } = await import('./desktop');

function makeAppConfig(allowedNodes?: string[]): AppConfig {
  return {
    agents: allowedNodes
      ? { main: { allowed_nodes: allowedNodes } }
      : { main: {} },
  } as unknown as AppConfig;
}

function makeFactoryContext(appConfig: AppConfig) {
  return {
    sessionId: 'sess-1',
    runId: 'run-1',
    appConfig,
    agentName: 'main',
    allowDelegation: false,
    source: { type: 'cli' } as never,
    workspaceLockAcquired: true,
    buildNestedTools: async () => ({}),
  };
}

function getExecute(
  toolset: Record<string, unknown> | null,
  name: string,
): (input: Record<string, unknown>) => Promise<unknown> {
  const execute = (toolset?.[name] as { execute?: unknown })?.execute;
  expect(typeof execute).toBe('function');
  return execute as (input: Record<string, unknown>) => Promise<unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAgentdAvailable.mockResolvedValue(true);
  mockExecToolOnAgentd.mockResolvedValue({ success: true, data: 'ok' });
});

describe('browser dispatcher — allowedNodes', () => {
  it('forwards the agent allowed_nodes allowlist to execToolOnAgentd', async () => {
    const toolset = await browserDefinition.factory(
      {} as never,
      makeFactoryContext(makeAppConfig(['node-a', 'node-b'])),
    );

    const execute = getExecute(toolset, 'browser_navigate');
    await execute({ url: 'https://example.com' });

    expect(mockExecToolOnAgentd).toHaveBeenCalledTimes(1);
    expect(mockExecToolOnAgentd).toHaveBeenCalledWith(
      'sess-1',
      'browser_navigate',
      expect.objectContaining({ url: 'https://example.com' }),
      undefined, // no model-supplied nodeId
      ['node-a', 'node-b'], // allowedNodes — was previously hardcoded undefined
      true, // workspaceLockAcquired
    );
  });

  it('passes undefined allowedNodes when the agent has no allowlist configured', async () => {
    const toolset = await browserDefinition.factory(
      {} as never,
      makeFactoryContext(makeAppConfig()),
    );

    const execute = getExecute(toolset, 'browser_click');
    await execute({ x: 10, y: 20 });

    expect(mockExecToolOnAgentd).toHaveBeenCalledWith(
      'sess-1',
      'browser_click',
      expect.objectContaining({ x: 10, y: 20 }),
      undefined,
      undefined, // no allowlist configured → no restriction
      true,
    );
  });
});

describe('desktop dispatcher — allowedNodes', () => {
  it('forwards the agent allowed_nodes allowlist to execToolOnAgentd', async () => {
    mockExecToolOnAgentd.mockResolvedValue({
      success: true,
      data: JSON.stringify({ image: 'data:image/png;base64,AAA' }),
    });

    const toolset = await desktopDefinition.factory(
      {} as never,
      makeFactoryContext(makeAppConfig(['node-a'])),
    );

    const execute = getExecute(toolset, 'desktop_screenshot');
    await execute({});

    expect(mockExecToolOnAgentd).toHaveBeenCalledTimes(1);
    expect(mockExecToolOnAgentd).toHaveBeenCalledWith(
      'sess-1',
      'desktop_screenshot',
      // Screenshot defaults are backfilled to JPEG q80.
      { format: 'jpeg', quality: 80 },
      undefined,
      ['node-a'], // allowedNodes — was previously hardcoded undefined
      true,
    );
  });

  it('preserves a model-supplied nodeId alongside the allowlist', async () => {
    const toolset = await desktopDefinition.factory(
      {} as never,
      makeFactoryContext(makeAppConfig(['node-a'])),
    );

    const execute = getExecute(toolset, 'desktop_click');
    await execute({ x: 5, y: 6, nodeId: 'node-a' });

    expect(mockExecToolOnAgentd).toHaveBeenCalledWith(
      'sess-1',
      'desktop_click',
      expect.objectContaining({ x: 5, y: 6 }),
      'node-a', // nodeId flow preserved
      ['node-a'], // allowlist still enforced against it inside execToolOnAgentd
      true,
    );
  });
});
