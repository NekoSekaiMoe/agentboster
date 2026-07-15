/**
 * Tests for forwardL2Confirm's node-routing logic.
 *
 * The node-pin fix lives here: an L2 verdict must land on the daemon
 * that raised the authorization (it holds the paused task + L2AuthManager
 * cache), not on the default nodes[0]/AGENTD_URL. The l2-confirm route
 * test mocks forwardL2Confirm entirely, so this suite is the only place
 * that exercises the genuinely new code — the by-nodeId config resolution
 * and the fallback when nodeId is absent or no longer resolves.
 *
 * Strategy: mock requestAgentd to capture which AgentdHttpConfig it was
 * handed (each helper returns a config with a distinct baseUrl marker),
 * and mock the two config helpers so we control resolution without a DB.
 *
 * Run via: yarn test lib/extra/agent/agentd-client.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the config requestAgentd receives so we can assert routing.
// The explicit parameter signature makes `.mock.calls[0]` a 4-tuple so
// the destructuring assertions below typecheck (without it, tsc infers
// an empty-tuple call signature and flags calls[0] indexing).
const requestAgentdMock = vi.fn(
  async (
    _config: unknown,
    _method: string,
    _path: string,
    _body?: unknown,
  ): Promise<{ ok: boolean; status: number; text: string }> => ({
    ok: true,
    status: 200,
    text: JSON.stringify({ success: true }),
  }),
);

vi.mock('./agentd-http', () => ({
  requestAgentd: requestAgentdMock,
}));

// Two distinct config markers so the assertion can tell which resolution
// path forwardL2Confirm took.
const DEFAULT_CONFIG = { baseUrl: 'http://default.example.test', apiKey: 'k' };
const NODE_CONFIG = { baseUrl: 'http://node-b.example.test', apiKey: 'k' };

const getAgentdClientConfigMock = vi.fn(async () => DEFAULT_CONFIG);
const getAgentdClientConfigByNodeIdMock = vi.fn(
  async (_nodeId: string): Promise<typeof NODE_CONFIG | null> => NODE_CONFIG,
);

vi.mock('./agentd-tools-client', () => ({
  getAgentdClientConfig: getAgentdClientConfigMock,
  getAgentdClientConfigByNodeId: getAgentdClientConfigByNodeIdMock,
}));

async function callForward(payload: {
  task_id: string;
  decision_id: string;
  action: string;
  duration?: string;
  nodeId?: string;
}) {
  const { forwardL2Confirm } = await import('./agentd-client');
  return forwardL2Confirm(payload);
}

const baseVerdict = {
  task_id: 'task-1',
  decision_id: 'dec-1',
  action: 'pass_once',
  duration: 'once',
};

beforeEach(() => {
  vi.clearAllMocks();
  getAgentdClientConfigMock.mockResolvedValue(DEFAULT_CONFIG);
  getAgentdClientConfigByNodeIdMock.mockResolvedValue(NODE_CONFIG);
  requestAgentdMock.mockResolvedValue({
    ok: true,
    status: 200,
    text: JSON.stringify({ success: true }),
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('forwardL2Confirm: node routing', () => {
  it('routes to the raising daemon when nodeId resolves', async () => {
    await callForward({ ...baseVerdict, nodeId: 'node-b' });

    expect(getAgentdClientConfigByNodeIdMock).toHaveBeenCalledWith('node-b');
    expect(getAgentdClientConfigMock).not.toHaveBeenCalled();
    // requestAgentd got the node-specific config, not the default.
    expect(requestAgentdMock).toHaveBeenCalledTimes(1);
    const [config, method, path, body] = requestAgentdMock.mock.calls[0];
    expect(config).toBe(NODE_CONFIG);
    expect(method).toBe('POST');
    expect(path).toBe('/api/v1/l2-confirm');
    // nodeId is a routing hint, not part of the daemon payload.
    expect(body).not.toHaveProperty('nodeId');
    expect(body).toMatchObject({
      task_id: 'task-1',
      decision_id: 'dec-1',
      action: 'pass_once',
      duration: 'once',
    });
  });

  it('uses default resolution when nodeId is absent', async () => {
    await callForward(baseVerdict);

    expect(getAgentdClientConfigByNodeIdMock).not.toHaveBeenCalled();
    expect(getAgentdClientConfigMock).toHaveBeenCalledTimes(1);
    const [config] = requestAgentdMock.mock.calls[0];
    expect(config).toBe(DEFAULT_CONFIG);
  });

  it('falls back to default when the nodeId no longer resolves', async () => {
    getAgentdClientConfigByNodeIdMock.mockResolvedValue(null);

    await callForward({ ...baseVerdict, nodeId: 'gone' });

    expect(getAgentdClientConfigByNodeIdMock).toHaveBeenCalledWith('gone');
    // Fell through to the default path.
    expect(getAgentdClientConfigMock).toHaveBeenCalledTimes(1);
    const [config] = requestAgentdMock.mock.calls[0];
    expect(config).toBe(DEFAULT_CONFIG);
  });

  it('falls back to default when the resolver throws', async () => {
    getAgentdClientConfigByNodeIdMock.mockRejectedValue(
      new Error('DB connection lost'),
    );

    await callForward({ ...baseVerdict, nodeId: 'node-b' });

    expect(getAgentdClientConfigByNodeIdMock).toHaveBeenCalledWith('node-b');
    expect(getAgentdClientConfigMock).toHaveBeenCalledTimes(1);
    const [config] = requestAgentdMock.mock.calls[0];
    expect(config).toBe(DEFAULT_CONFIG);
  });
});

describe('forwardL2Confirm: error propagation', () => {
  it('throws when the daemon returns a non-ok HTTP status', async () => {
    requestAgentdMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: 'unavailable',
    });

    await expect(
      callForward({ ...baseVerdict, nodeId: 'node-b' }),
    ).rejects.toThrow(/503/);
  });

  it('throws when the daemon envelope reports success=false', async () => {
    requestAgentdMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: JSON.stringify({ success: false, error: 'no such task' }),
    });

    await expect(
      callForward({ ...baseVerdict, nodeId: 'node-b' }),
    ).rejects.toThrow(/no such task/);
  });
});
