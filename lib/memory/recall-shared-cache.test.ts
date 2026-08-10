/**
 * Dual-user regression test for shared-memory cache invalidation.
 *
 * Bug being pinned: recall caches keyed by requester userId + workspaceId
 * were only invalidated for the WRITER. When user A created/updated/deleted
 * a shared memory in workspace W, user B's cached workspace-scoped recall
 * kept serving the stale result until the 60s TTL expired.
 *
 * Fix under test: the DAL bumps a per-workspace version in KV on any
 * shared-row mutation (lib/memory/shared-version.ts, called from
 * lib/core/db/memory/long-term.ts), and recall folds that version into
 * its cache key. This test drives the reader side against an in-memory
 * KV mock: user B caches a recall, the workspace version is bumped
 * (exactly what the DAL does on A's write), and B's next recall must
 * re-read immediately — no TTL wait.
 *
 * The writer-side bump wiring itself is covered by
 * lib/core/db/memory/long-term.shared-version.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { kvStore, kvGetSpy, kvIncrSpy } = vi.hoisted(() => ({
  kvStore: new Map<string, string>(),
  kvGetSpy: vi.fn(),
  kvIncrSpy: vi.fn(),
}));

vi.mock('@/lib/core/kv', () => ({
  get: kvGetSpy.mockImplementation(async (key: string) => {
    return kvStore.get(key) ?? null;
  }),
  set: vi.fn(async (key: string, value: unknown) => {
    kvStore.set(key, String(value));
    return 'OK';
  }),
  del: vi.fn(async (...keys: string[]) => {
    let removed = 0;
    for (const key of keys) {
      if (kvStore.delete(key)) removed += 1;
    }
    return removed;
  }),
  incr: kvIncrSpy.mockImplementation(async (key: string) => {
    const next = Number.parseInt(kvStore.get(key) ?? '0', 10) + 1;
    kvStore.set(key, String(next));
    return next;
  }),
}));

vi.mock('@/lib/core/db/memory/long-term', () => ({
  listLongTermMemoryRows: vi.fn(),
  getMemoryMetaByIds: vi.fn().mockResolvedValue(new Map()),
  recordRecallHits: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/core/db/memory/edges', () => ({
  getConnectedMemoryIds: vi.fn().mockResolvedValue([]),
  getMemoryContentByIds: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('@/lib/memory/long-term', () => ({
  searchLongTermMemories: vi.fn(),
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

import { searchLongTermMemories } from '@/lib/memory/long-term';
import type { AppConfig } from '@/types/config';
import { invalidateRecallCache, recallRelevantMemories } from './recall';
import {
  bumpSharedMemoryVersion,
  readSharedMemoryVersion,
  sharedMemoryVersionKey,
} from './shared-version';

const WORKSPACE = 'workspace-shared-1';
const OTHER_WORKSPACE = 'workspace-shared-2';
// User A (the writer) never calls recall in this test — its writes are
// simulated via bumpSharedMemoryVersion, exactly what the DAL invokes.
const USER_B = 'user-b-reader';

function makeConfig(): AppConfig {
  // Vector strategy: recall goes through the (mocked) searchLongTermMemories
  // without needing an LLM scorer.
  return {
    models: { model: 'main-model', embedding_model: 'text-embedding-3-small' },
  } as AppConfig;
}

function searchRow(memoryId: string, content: string) {
  return {
    chunkId: `chunk-${memoryId}`,
    memoryId,
    content,
    vectorScore: 0.9,
    keywordScore: 0,
    finalScore: 0.9,
  };
}

describe('shared-memory version counter', () => {
  beforeEach(() => {
    kvStore.clear();
    kvGetSpy.mockClear();
    kvIncrSpy.mockClear();
  });

  it('starts at 0 and increments atomically in KV', async () => {
    expect(await readSharedMemoryVersion(WORKSPACE)).toBe(0);
    expect(await bumpSharedMemoryVersion(WORKSPACE)).toBe(1);
    expect(await bumpSharedMemoryVersion(WORKSPACE)).toBe(2);
    expect(await readSharedMemoryVersion(WORKSPACE)).toBe(2);
    expect(kvIncrSpy).toHaveBeenCalledWith(sharedMemoryVersionKey(WORKSPACE));
  });

  it('fails soft to 0 when the KV read throws (safe direction: cache miss)', async () => {
    kvGetSpy.mockRejectedValueOnce(new Error('kv down'));
    await expect(readSharedMemoryVersion(WORKSPACE)).resolves.toBe(0);
  });

  it('fails soft to 0 when the KV bump throws (write must not fail)', async () => {
    kvIncrSpy.mockRejectedValueOnce(new Error('kv down'));
    await expect(bumpSharedMemoryVersion(WORKSPACE)).resolves.toBe(0);
  });
});

describe('recallRelevantMemories — cross-user shared invalidation', () => {
  beforeEach(() => {
    kvStore.clear();
    kvGetSpy.mockClear();
    kvIncrSpy.mockClear();
    vi.mocked(searchLongTermMemories).mockReset();
    invalidateRecallCache();
  });

  it('user B sees user A’s shared-memory write IMMEDIATELY (no TTL wait)', async () => {
    const config = makeConfig();

    // 1. User B recalls in workspace W → result cached under W's version.
    vi.mocked(searchLongTermMemories).mockResolvedValue([
      searchRow('m-b-personal', 'B personal fact'),
    ]);
    const first = await recallRelevantMemories({
      userId: USER_B,
      query: 'project setup',
      workspaceId: WORKSPACE,
      config,
    });
    expect(first.map((m) => m.content)).toEqual(['B personal fact']);
    expect(searchLongTermMemories).toHaveBeenCalledTimes(1);

    // 2. Same recall again → served from cache (writer would TTL-stall here).
    const cached = await recallRelevantMemories({
      userId: USER_B,
      query: 'project setup',
      workspaceId: WORKSPACE,
      config,
    });
    expect(cached.map((m) => m.content)).toEqual(['B personal fact']);
    expect(searchLongTermMemories).toHaveBeenCalledTimes(1);

    // 3. User A writes a SHARED memory into workspace W. The DAL bumps the
    //    workspace version (asserted separately in the DAL test); simulate
    //    that bump through the same helper the DAL calls.
    vi.mocked(searchLongTermMemories).mockResolvedValue([
      searchRow('m-b-personal', 'B personal fact'),
      searchRow('m-a-shared', 'A shared fact v1'),
    ]);
    await bumpSharedMemoryVersion(WORKSPACE);

    // 4. User B's very next recall reflects the write — cache key moved.
    const after = await recallRelevantMemories({
      userId: USER_B,
      query: 'project setup',
      workspaceId: WORKSPACE,
      config,
    });
    expect(searchLongTermMemories).toHaveBeenCalledTimes(2);
    expect(after.map((m) => m.content)).toEqual([
      'B personal fact',
      'A shared fact v1',
    ]);

    // 5. A mutates the shared row again (update/delete both bump) → B sees
    //    the new shape immediately too.
    vi.mocked(searchLongTermMemories).mockResolvedValue([
      searchRow('m-b-personal', 'B personal fact'),
      searchRow('m-a-shared', 'A shared fact v2'),
    ]);
    await bumpSharedMemoryVersion(WORKSPACE);

    const afterV2 = await recallRelevantMemories({
      userId: USER_B,
      query: 'project setup',
      workspaceId: WORKSPACE,
      config,
    });
    expect(searchLongTermMemories).toHaveBeenCalledTimes(3);
    expect(afterV2.map((m) => m.content)).toEqual([
      'B personal fact',
      'A shared fact v2',
    ]);
  });

  it('a bump in workspace W does NOT invalidate cached recall for workspace W2', async () => {
    const config = makeConfig();
    vi.mocked(searchLongTermMemories).mockResolvedValue([
      searchRow('m-w2', 'W2 scoped fact'),
    ]);

    await recallRelevantMemories({
      userId: USER_B,
      query: 'other project',
      workspaceId: OTHER_WORKSPACE,
      config,
    });
    expect(searchLongTermMemories).toHaveBeenCalledTimes(1);

    await bumpSharedMemoryVersion(WORKSPACE);

    const again = await recallRelevantMemories({
      userId: USER_B,
      query: 'other project',
      workspaceId: OTHER_WORKSPACE,
      config,
    });
    // Still a cache hit — W's version is irrelevant to W2-scoped recall.
    expect(searchLongTermMemories).toHaveBeenCalledTimes(1);
    expect(again.map((m) => m.content)).toEqual(['W2 scoped fact']);
  });

  it('personal (workspace-less) recall never reads the version counter and is bump-immune', async () => {
    const config = makeConfig();
    vi.mocked(searchLongTermMemories).mockResolvedValue([
      searchRow('m-personal', 'global personal fact'),
    ]);

    await recallRelevantMemories({
      userId: USER_B,
      query: 'my preferences',
      config,
    });
    const again = await recallRelevantMemories({
      userId: USER_B,
      query: 'my preferences',
      config,
    });

    expect(searchLongTermMemories).toHaveBeenCalledTimes(1);
    expect(again.map((m) => m.content)).toEqual(['global personal fact']);
    // No workspace scope → the version counter is never consulted and the
    // cache key format is unchanged from before the fix.
    expect(kvGetSpy).not.toHaveBeenCalled();

    // A workspace bump must not disturb personal recall either.
    await bumpSharedMemoryVersion(WORKSPACE);
    await recallRelevantMemories({
      userId: USER_B,
      query: 'my preferences',
      config,
    });
    expect(searchLongTermMemories).toHaveBeenCalledTimes(1);
  });

  it('still serves fresh data when the KV version read fails (fail-soft → cache miss)', async () => {
    const config = makeConfig();
    vi.mocked(searchLongTermMemories).mockResolvedValue([
      searchRow('m-a-shared', 'A shared fact'),
    ]);
    await bumpSharedMemoryVersion(WORKSPACE);

    kvGetSpy.mockRejectedValueOnce(new Error('kv down'));
    const result = await recallRelevantMemories({
      userId: USER_B,
      query: 'project setup',
      workspaceId: WORKSPACE,
      config,
    });

    expect(searchLongTermMemories).toHaveBeenCalledTimes(1);
    expect(result.map((m) => m.content)).toEqual(['A shared fact']);
  });
});
