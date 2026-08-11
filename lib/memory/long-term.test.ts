/**
 * Runtime-validation tests for the shared-memory write APIs
 * (createLongTermMemory / upsertLongTermMemory).
 *
 * Guard under test: shared=true without a workspaceId must throw BEFORE
 * any DB write. A shared row with workspace_id NULL would be visible to
 * every workspace's members (recall's scope match allows
 * `workspace_id IS NULL`) and would never bump any workspace version, so
 * other members' caches would not even be invalidated. shared=false/unset
 * behavior is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createRowMock, upsertByKeyMock, replaceChunksMock } = vi.hoisted(
  () => ({
    createRowMock: vi.fn(),
    upsertByKeyMock: vi.fn(),
    replaceChunksMock: vi.fn(),
  }),
);

vi.mock('@/lib/core/db/memory/long-term', () => ({
  createLongTermMemoryRow: createRowMock,
  deleteLongTermMemoryRow: vi.fn(),
  getLongTermMemoryRow: vi.fn(),
  hybridSearchLongTermMemoryChunks: vi.fn(),
  listAllLongTermMemoryRows: vi.fn(),
  listLongTermMemoryRows: vi.fn(),
  replaceLongTermMemoryChunks: replaceChunksMock,
  updateLastAccessedAt: vi.fn(),
  updateLongTermMemoryRow: vi.fn(),
  upsertLongTermMemoryByKey: upsertByKeyMock,
}));

// Side-effect modules on the success path: keep the test hermetic.
vi.mock('@/lib/memory/edges', () => ({
  deriveEdgesForMemory: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/memory/profile', () => ({
  invalidateProfileCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/memory/recall', () => ({
  invalidateRecallCache: vi.fn(),
}));
vi.mock('@/lib/memory/triggers', () => ({
  invalidateTriggerCache: vi.fn(),
}));
vi.mock('@/lib/memory/provider/write-gate', () => ({
  bumpMemoryVersion: vi.fn().mockResolvedValue(undefined),
}));

import type { AppConfig } from '@/types/config';
import { createLongTermMemory, upsertLongTermMemory } from './long-term';

const CONFIG = {} as AppConfig;

describe('createLongTermMemory shared/workspaceId validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createRowMock.mockResolvedValue({ id: 'mem-1', content: 'fact' });
    replaceChunksMock.mockResolvedValue(undefined);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace-only', '   '],
  ])(
    'throws for shared=true with workspaceId %s, before any DB write',
    async (_label, workspaceId) => {
      await expect(
        createLongTermMemory({ content: 'fact', shared: true, workspaceId }),
      ).rejects.toThrow('shared memories require a workspaceId');
      expect(createRowMock).not.toHaveBeenCalled();
    },
  );

  it('accepts shared=true with a valid workspaceId', async () => {
    const result = await createLongTermMemory({
      content: 'fact',
      shared: true,
      workspaceId: 'ws-1',
      config: CONFIG,
    });
    expect(createRowMock).toHaveBeenCalledWith(
      'fact',
      expect.objectContaining({ shared: true, workspaceId: 'ws-1' }),
    );
    expect(result.memory.id).toBe('mem-1');
  });

  it.each([
    ['unset', undefined],
    ['false', false],
  ])(
    'behavior unchanged for shared %s without workspaceId',
    async (_label, shared) => {
      await createLongTermMemory({
        content: 'fact',
        shared,
        config: CONFIG,
      });
      expect(createRowMock).toHaveBeenCalledWith(
        'fact',
        expect.objectContaining({ shared }),
      );
    },
  );
});

describe('upsertLongTermMemory shared/workspaceId validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertByKeyMock.mockResolvedValue({
      row: { id: 'mem-1', content: 'fact' },
      created: true,
    });
    replaceChunksMock.mockResolvedValue(undefined);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace-only', '   '],
  ])(
    'throws for shared=true with workspaceId %s, before any DB write',
    async (_label, workspaceId) => {
      await expect(
        upsertLongTermMemory({
          userId: 'user-1',
          key: 'k',
          content: 'fact',
          shared: true,
          workspaceId,
        }),
      ).rejects.toThrow('shared memories require a workspaceId');
      expect(upsertByKeyMock).not.toHaveBeenCalled();
    },
  );

  it('accepts shared=true with a valid workspaceId', async () => {
    const result = await upsertLongTermMemory({
      userId: 'user-1',
      key: 'k',
      content: 'fact',
      shared: true,
      workspaceId: 'ws-1',
      config: CONFIG,
    });
    expect(upsertByKeyMock).toHaveBeenCalledWith(
      expect.objectContaining({ shared: true, workspaceId: 'ws-1' }),
    );
    expect(result.created).toBe(true);
  });

  it.each([
    ['unset', undefined],
    ['false', false],
  ])(
    'behavior unchanged for shared %s without workspaceId',
    async (_label, shared) => {
      await upsertLongTermMemory({
        userId: 'user-1',
        key: 'k',
        content: 'fact',
        shared,
        config: CONFIG,
      });
      expect(upsertByKeyMock).toHaveBeenCalledWith(
        expect.objectContaining({ shared }),
      );
    },
  );
});
