/**
 * Tests for the multi-node scheduler's score function.
 *
 * P3.2: selectBestNode is the entry point for the entire daemon
 * dispatch path; its scoring was previously untested. We mock the DB
 * layer and exercise the candidate filtering + scoring branches added
 * in P3.1 (allowed_nodes filter, active-load weight).
 *
 * Run via: yarn test lib/workflow/agent/dispatch.test.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the DB before importing the module under test.
const mockRows: Array<Record<string, unknown>> = [];
vi.mock('@/lib/core/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(mockRows),
      }),
    }),
  },
}));
const checkAgentdHealthMock = vi.fn(async () => true);
vi.mock('@/lib/extra/agent/agentd-tools-client', () => ({
  checkAgentdHealth: checkAgentdHealthMock,
}));
vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  }),
}));

// Import after the mocks are in place.
const { selectBestNode, isAgentdAvailable } = await import('./dispatch');

function makeRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    nodeID: 'node-1',
    ip: '10.0.0.1',
    port: 8443,
    sandboxes: ['docker', 'docker-strict', 'lxc'],
    status: 'online',
    cpuUsage: 30,
    memAvail: 70,
    diskAvail: 80,
    activeTasks: 0,
    activeSandboxes: 0,
    lastHeartbeat: new Date(),
    ...overrides,
  };
}

describe('selectBestNode', () => {
  beforeEach(() => {
    mockRows.length = 0;
    checkAgentdHealthMock.mockReset();
    checkAgentdHealthMock.mockResolvedValue(true);
  });

  it('returns null when no nodes are online', async () => {
    const result = await selectBestNode();
    expect(result).toBeNull();
  });

  it('returns the only available node', async () => {
    mockRows.push(makeRow());
    const result = await selectBestNode();
    expect(result?.nodeID).toBe('node-1');
  });

  it('picks the less-loaded node when CPU/mem are equal', async () => {
    mockRows.push(
      makeRow({
        nodeID: 'busy',
        cpuUsage: 40,
        memAvail: 60,
        diskAvail: 80,
        activeTasks: 5,
        activeSandboxes: 3,
      }),
      makeRow({
        nodeID: 'idle',
        cpuUsage: 40,
        memAvail: 60,
        diskAvail: 80,
        activeTasks: 0,
        activeSandboxes: 0,
      }),
    );
    const result = await selectBestNode();
    expect(result?.nodeID).toBe('idle');
  });

  it('skips overloaded nodes (cpu >= 0.9)', async () => {
    mockRows.push(
      makeRow({ nodeID: 'overload', cpuUsage: 95 }),
      makeRow({ nodeID: 'ok', cpuUsage: 50 }),
    );
    const result = await selectBestNode();
    expect(result?.nodeID).toBe('ok');
  });

  it('skips nodes with low memory (mem <= 0.1)', async () => {
    mockRows.push(
      makeRow({ nodeID: 'low-mem', memAvail: 5 }),
      makeRow({ nodeID: 'healthy', memAvail: 50 }),
    );
    const result = await selectBestNode();
    expect(result?.nodeID).toBe('healthy');
  });

  it('filters by required sandbox type', async () => {
    mockRows.push(
      makeRow({ nodeID: 'lxc-only', sandboxes: ['lxc'] }),
      makeRow({ nodeID: 'all', sandboxes: ['docker', 'lxc', 'docker-strict'] }),
    );
    const result = await selectBestNode('docker-strict');
    expect(result?.nodeID).toBe('all');
  });

  it('returns null when no node has the required sandbox type', async () => {
    mockRows.push(makeRow({ sandboxes: ['docker'] }));
    const result = await selectBestNode('lxc');
    expect(result).toBeNull();
  });

  it('P3.1: filters by allowedNodes when provided', async () => {
    mockRows.push(
      makeRow({ nodeID: 'a' }),
      makeRow({ nodeID: 'b' }),
      makeRow({ nodeID: 'c' }),
    );
    const result = await selectBestNode(undefined, ['b', 'c']);
    expect(result?.nodeID).toBe('b'); // both equally free, tiebreak by activeTasks
  });

  it('P3.1: returns null when allowedNodes excludes everything', async () => {
    mockRows.push(makeRow({ nodeID: 'a' }));
    const result = await selectBestNode(undefined, ['nonexistent']);
    expect(result).toBeNull();
  });

  it('P3.1: empty allowedNodes list means "any node"', async () => {
    mockRows.push(makeRow({ nodeID: 'a' }));
    const result = await selectBestNode(undefined, []);
    expect(result?.nodeID).toBe('a');
  });

  it('P3.3: node with high sandbox memory peak loses to a peer', async () => {
    mockRows.push(
      makeRow({ nodeID: 'pressured', sandboxMemPeakTotal: 10 * 1024 ** 3 }),
      makeRow({ nodeID: 'idle', sandboxMemPeakTotal: 0 }),
    );
    const result = await selectBestNode();
    expect(result?.nodeID).toBe('idle');
  });

  it('P3.3: null sandboxMemPeakTotal is treated as zero (no penalty)', async () => {
    mockRows.push(
      makeRow({ nodeID: 'nodata', sandboxMemPeakTotal: null }),
      makeRow({ nodeID: 'idle', sandboxMemPeakTotal: 0 }),
    );
    const result = await selectBestNode();
    // Both equally scored; tiebreak by activeTasks (both 0), so it
    // falls back to insertion order — nodata comes first.
    expect(result?.nodeID).toBe('nodata');
  });

  it('P3.3: sub-1GB sandbox memory peak applies only marginal penalty', async () => {
    mockRows.push(
      makeRow({ nodeID: 'small-load', sandboxMemPeakTotal: 500 * 1024 ** 2 }),
      makeRow({ nodeID: 'idle', sandboxMemPeakTotal: 0 }),
    );
    const result = await selectBestNode();
    // 500MB / 8GB ≈ 0.0625 pressure → 0.03 score impact. Other
    // dimensions are identical so 'idle' still wins, but 'small-load'
    // is not skipped (would be the case under hard cutoff).
    expect(result?.nodeID).toBe('idle');
  });
});

describe('isAgentdAvailable', () => {
  beforeEach(() => {
    mockRows.length = 0;
    checkAgentdHealthMock.mockReset();
    checkAgentdHealthMock.mockResolvedValue(true);
  });

  it('returns false when no node is online in DB', async () => {
    const result = await isAgentdAvailable();
    expect(result).toBe(false);
    expect(checkAgentdHealthMock).not.toHaveBeenCalled();
  });

  it('probes the selected node (not nodes[0]) when verifying health', async () => {
    // 'idle' wins the scoring race, so isAgentdAvailable must pass
    // { nodeID: 'idle', ip, port } to checkAgentdHealth — not 'busy'.
    mockRows.push(
      makeRow({
        nodeID: 'busy',
        ip: '10.0.0.1',
        port: 18732,
        cpuUsage: 80,
        memAvail: 30,
        activeTasks: 9,
      }),
      makeRow({
        nodeID: 'idle',
        ip: '10.0.0.2',
        port: 18733,
        cpuUsage: 10,
        memAvail: 90,
        activeTasks: 0,
      }),
    );

    const result = await isAgentdAvailable();
    expect(result).toBe(true);
    expect(checkAgentdHealthMock).toHaveBeenCalledTimes(1);
    expect(checkAgentdHealthMock).toHaveBeenCalledWith({
      nodeID: 'idle',
      ip: '10.0.0.2',
      port: 18733,
    });
  });

  it('returns false when the selected node fails the health probe', async () => {
    mockRows.push(makeRow({ nodeID: 'a', ip: '10.0.0.1', port: 18732 }));
    checkAgentdHealthMock.mockResolvedValueOnce(false);

    const result = await isAgentdAvailable();
    expect(result).toBe(false);
    expect(checkAgentdHealthMock).toHaveBeenCalledWith({
      nodeID: 'a',
      ip: '10.0.0.1',
      port: 18732,
    });
  });
});
