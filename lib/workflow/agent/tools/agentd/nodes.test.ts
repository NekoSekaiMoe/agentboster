import type { AppConfig } from '@/types/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tests for the agentd-nodes builtin tool.
 *
 * The factory gates itself on an online-node count probe (`db.select` on
 * `agentd_nodes`). In production this code runs inside the Workflow DevKit
 * vm sandbox; `'use step'` functions are marshalled back to the host
 * where `fetch` (required by @neondatabase/serverless) exists. These
 * tests execute on the host directly, so the step marshalling does not
 * happen — the function bodies run inline. That is fine for testing
 * factory gating logic and tool `execute` bodies, but it means these
 * tests do NOT exercise the sandbox/host boundary. See AGENTS.md
 * "Workflow DevKit sandbox" section for why that boundary matters.
 */

const SOURCE_PATH = join(__dirname, 'nodes.ts');

// `db` is normally a lazy Proxy that initializes @neondatabase/serverless
// on first access. The Proxy shape breaks `vi.spyOn(db, 'select')`
// because the property is installed lazily on the underlying target and
// is not own/enumerable at module-eval time. Replace the whole module
// with a chainable mock so spies can hook into any link of the query
// builder chain.
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
function resetChain() {
  mockSelect.mockReturnValue({
    from: mockFrom.mockReturnValue({
      where: mockWhere,
    }),
  });
}

vi.mock('@/lib/core/db', () => ({
  db: {
    select: mockSelect,
  },
}));

// selectBestNode lives in dispatch.ts and calls db internally; the
// getBestNode execute path is exercised only through its return value,
// so we replace it with a deterministic stub. Importing it lazily inside
// the test avoids coupling the mock to module-eval order.
vi.mock('@/lib/workflow/agent/dispatch', () => ({
  selectBestNode: vi.fn(),
}));

const { default: definition } = await import('./nodes');
const { selectBestNode } = await import('@/lib/workflow/agent/dispatch');

function makeAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    agentd: { enabled: true },
  } as unknown as AppConfig;
}

const sampleNode = {
  nodeID: 'node-a',
  ip: '10.0.0.1',
  port: 18732,
  sandboxes: ['docker', 'lxc'],
  cpuModel: 'x86-64',
  cpuUsage: 12,
  memAvail: 60,
  diskAvail: 75,
  activeTasks: 0,
  activeSandboxes: 0,
};

beforeEach(() => {
  resetChain();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('agentd-nodes tool — static guarantees', () => {
  it('every db query helper is declared as a `use step` function', () => {
    // Regression test for the sandbox-fetch bug documented in AGENTS.md.
    // The factory + execute callbacks reach `db` through helpers that
    // MUST be `use step` functions — otherwise the query runs inside
    // the vm sandbox where `fetch` is undefined, and the workflow
    // aborts with `Error: Failed query: <sql>` (no underlying Postgres
    // message). We assert the source contains the directive inside each
    // helper rather than relying on a runtime marker (the Workflow
    // DevKit strips the directive at compile time, so a function-shape
    // check would not catch a regression).
    const src = readFileSync(SOURCE_PATH, 'utf8');

    const stepHelpers = ['listOnlineNodesStep', 'hasMultipleOnlineNodesStep'];
    for (const name of stepHelpers) {
      const fnStart = src.indexOf(`async function ${name}`);
      expect(fnStart, `${name} must exist in source`).toBeGreaterThan(-1);
      const directivePos = src.indexOf("'use step'", fnStart);
      const fnEnd = src.indexOf('\n}', directivePos);
      expect(
        directivePos,
        `${name} must contain a 'use step' directive`,
      ).toBeGreaterThan(fnStart);
      expect(
        fnEnd,
        `${name} directive must be inside the function body`,
      ).toBeGreaterThan(directivePos);
    }
  });
});

describe('agentd-nodes tool — factory gating', () => {
  it('returns null when agentd is disabled', async () => {
    const result = await definition.factory({} as never, {
      sessionId: 's',
      runId: 'r',
      appConfig: { agentd: { enabled: false } } as unknown as AppConfig,
      agentName: 'main',
      allowDelegation: false,
      buildNestedTools: async () => ({}),
    });

    expect(result).toBeNull();
  });

  it('returns null when fewer than 2 online nodes', async () => {
    mockWhere.mockResolvedValueOnce([sampleNode]);

    const result = await definition.factory({} as never, {
      sessionId: 's',
      runId: 'r',
      appConfig: makeAppConfig(),
      agentName: 'main',
      allowDelegation: false,
      buildNestedTools: async () => ({}),
    });

    expect(result).toBeNull();
  });

  it('registers listNodes + getBestNode when ≥2 online nodes', async () => {
    mockWhere.mockResolvedValueOnce([
      sampleNode,
      { ...sampleNode, nodeID: 'node-b' },
    ]);

    const result = await definition.factory({} as never, {
      sessionId: 's',
      runId: 'r',
      appConfig: makeAppConfig(),
      agentName: 'main',
      allowDelegation: false,
      buildNestedTools: async () => ({}),
    });

    expect(result).not.toBeNull();
    expect(Object.keys(result ?? {})).toEqual(['listNodes', 'getBestNode']);
  });

  it('returns null (does NOT throw) when the db probe fails', async () => {
    // The factory gates on a db query that, in production, runs in the
    // vm sandbox. If the query ever fails for any reason (transient db
    // error, sandbox regression, fetch missing), the factory must
    // degrade gracefully rather than aborting the whole workflow.
    mockWhere.mockRejectedValueOnce(new Error('simulated fetch failure'));

    const result = await definition.factory({} as never, {
      sessionId: 's',
      runId: 'r',
      appConfig: makeAppConfig(),
      agentName: 'main',
      allowDelegation: false,
      buildNestedTools: async () => ({}),
    });

    expect(result).toBeNull();
  });
});

describe('agentd-nodes tool — listNodes execute', () => {
  it('maps db rows into the LLM-facing node payload', async () => {
    mockWhere.mockResolvedValueOnce([
      sampleNode,
      { ...sampleNode, nodeID: 'node-b' },
    ]);

    const factoryResult = await definition.factory({} as never, {
      sessionId: 's',
      runId: 'r',
      appConfig: makeAppConfig(),
      agentName: 'main',
      allowDelegation: false,
      buildNestedTools: async () => ({}),
    });

    const listNodes = factoryResult?.listNodes;
    expect(listNodes).toBeDefined();
    const execute = (listNodes as {
      execute?: (i: unknown) => Promise<unknown>;
    }).execute;
    expect(typeof execute).toBe('function');

    // listNodes.execute calls listOnlineNodesStep again, so seed another
    // resolution for that invocation.
    mockWhere.mockResolvedValueOnce([
      sampleNode,
      { ...sampleNode, nodeID: 'node-b' },
    ]);

    const out = await execute!({});

    // cpuUsage 12 → "12%" (already integer percent in db)
    // memAvail 60 → memoryUsage "40%" (used = 100 - avail)
    expect(out).toMatchObject({
      totalNodes: 2,
      nodes: [
        expect.objectContaining({
          nodeId: 'node-a',
          cpuUsage: '12%',
          memoryUsage: '40%',
          diskUsage: '25%',
        }),
        expect.objectContaining({ nodeId: 'node-b' }),
      ],
    });
  });

  it('filters by requiredSandbox when provided', async () => {
    const dockerNode = { ...sampleNode, sandboxes: ['docker'] };
    const lxcOnlyNode = { ...sampleNode, nodeID: 'node-lxc', sandboxes: ['lxc'] };

    mockWhere.mockResolvedValueOnce([dockerNode, lxcOnlyNode]);
    const factoryResult = await definition.factory({} as never, {
      sessionId: 's',
      runId: 'r',
      appConfig: makeAppConfig(),
      agentName: 'main',
      allowDelegation: false,
      buildNestedTools: async () => ({}),
    });

    const listNodes = factoryResult?.listNodes;
    const execute = (listNodes as {
      execute?: (i: unknown) => Promise<unknown>;
    }).execute;

    mockWhere.mockResolvedValueOnce([dockerNode, lxcOnlyNode]);
    const out = (await execute!({ requiredSandbox: 'lxc' })) as {
      totalNodes: number;
      nodes: { nodeId: string }[];
    };

    expect(out.totalNodes).toBe(1);
    expect(out.nodes[0].nodeId).toBe('node-lxc');
  });

  it('getBestNode.execute forwards to selectBestNode and formats output', async () => {
    mockWhere.mockResolvedValueOnce([
      sampleNode,
      { ...sampleNode, nodeID: 'node-b' },
    ]);
    vi.mocked(selectBestNode).mockResolvedValueOnce({
      nodeID: 'node-a',
      ip: '10.0.0.1',
      port: 18732,
      sandboxes: [],
      cpuUsage: 12,
      memAvail: 60,
      diskAvail: 75,
      activeTasks: 0,
      sandboxMemPeakTotal: null,
    });

    const factoryResult = await definition.factory({} as never, {
      sessionId: 's',
      runId: 'r',
      appConfig: makeAppConfig(),
      agentName: 'main',
      allowDelegation: false,
      buildNestedTools: async () => ({}),
    });

    const getBestNode = factoryResult?.getBestNode;
    const execute = (getBestNode as {
      execute?: (i: unknown) => Promise<unknown>;
    }).execute;

    const out = await execute!({});

    expect(out).toMatchObject({
      available: true,
      nodeId: 'node-a',
      cpuUsage: '12%',
      memoryAvailable: '60%',
      diskAvailable: '75%',
    });
  });
});
