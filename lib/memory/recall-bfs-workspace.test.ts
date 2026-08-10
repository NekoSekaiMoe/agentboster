import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Workspace scoping for BFS graph expansion in vector recall.
 *
 * recallViaVector seeds from searchLongTermMemories (which already scopes
 * to workspace-or-global) and then expands 1 hop through memory_edges.
 * These tests pin the contract that the BFS neighbor queries
 * (getConnectedMemoryIds / getMemoryContentByIds) receive the same
 * workspaceId, so neighbors cannot leak another workspace's private
 * memories.
 */

vi.mock('@/lib/core/db/memory/long-term', () => ({
  listLongTermMemoryRows: vi.fn(),
  getMemoryMetaByIds: vi.fn().mockResolvedValue(new Map()),
  recordRecallHits: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/security/l1-scorer', () => ({
  scoreMemoryRelevance: vi.fn(),
}));

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import type { AppConfig } from '@/types/config';

const USER_ID = 'user-uuid-1';
const WORKSPACE_ID = 'ws-uuid-1';

function makeVectorConfig(): AppConfig {
  // embedding_model set → resolveRecallStrategy picks the vector path.
  return {
    models: {
      model: 'main-model',
      embedding_model: 'text-embedding-3-small',
    },
  } as AppConfig;
}

const SEED = {
  memoryId: 'seed-1',
  content: 'user lives in Tokyo',
  finalScore: 0.9,
};
const NEIGHBOR = {
  memoryId: 'nb-1',
  relation: 'related',
  weight: 1,
  seedId: 'seed-1',
};

async function setupMocks() {
  vi.resetModules();

  const searchSpy = vi.fn().mockResolvedValue([SEED]);
  const connectedSpy = vi.fn().mockResolvedValue([NEIGHBOR]);
  const contentSpy = vi
    .fn()
    .mockResolvedValue(new Map([['nb-1', 'user works at Acme']]));

  vi.doMock('@/lib/memory/long-term', () => ({
    searchLongTermMemories: searchSpy,
  }));
  vi.doMock('@/lib/core/db/memory/edges', () => ({
    getConnectedMemoryIds: connectedSpy,
    getMemoryContentByIds: contentSpy,
  }));

  const { recallRelevantMemories } = await import('./recall');
  return { recallRelevantMemories, searchSpy, connectedSpy, contentSpy };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recallViaVector BFS workspace scoping', () => {
  it('threads workspaceId into the BFS neighbor queries', async () => {
    const { recallRelevantMemories, searchSpy, connectedSpy, contentSpy } =
      await setupMocks();

    const result = await recallRelevantMemories({
      userId: USER_ID,
      query: 'where do I live',
      workspaceId: WORKSPACE_ID,
      config: makeVectorConfig(),
    });

    // Seed search was scoped (pre-existing behavior, pinned here).
    expect(searchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, workspaceId: WORKSPACE_ID }),
    );
    // The BFS edge query and the neighbor content fetch must receive the
    // same workspaceId so they can apply the workspace-or-global filter.
    expect(connectedSpy).toHaveBeenCalledWith(
      ['seed-1'],
      USER_ID,
      WORKSPACE_ID,
    );
    expect(contentSpy).toHaveBeenCalledWith(['nb-1'], USER_ID, WORKSPACE_ID);

    // Both the seed and the neighbor make it into the merged result.
    const contents = result.map((m) => m.content);
    expect(contents).toContain('user lives in Tokyo');
    expect(contents).toContain('user works at Acme');
  });

  it('passes null workspaceId through (unscoped legacy recall) without dropping it', async () => {
    const { recallRelevantMemories, connectedSpy, contentSpy } =
      await setupMocks();

    await recallRelevantMemories({
      userId: USER_ID,
      query: 'where do I live',
      config: makeVectorConfig(),
    });

    // No workspaceId → recall defaults to null; the edges helpers treat
    // null/undefined as "no workspace filter" (legacy behavior preserved).
    expect(connectedSpy).toHaveBeenCalledWith(['seed-1'], USER_ID, null);
    expect(contentSpy).toHaveBeenCalledWith(['nb-1'], USER_ID, null);
  });
});
