/**
 * Writer-side wiring test for shared-memory cache invalidation.
 *
 * Pins the contract that the DAL bumps the per-workspace version counter
 * (lib/memory/shared-version.ts) on every shared-row mutation, so no
 * caller — including routes that hit the DAL directly, like
 * app/api/workspaces/[id]/route.ts — can forget to invalidate other
 * workspace members' recall caches.
 *
 * The db handle is mocked with chainable insert/update/delete/select
 * stubs; KV is mocked with an incr spy. Reader-side behavior is covered
 * by lib/memory/recall-shared-cache.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { incrSpy, state } = vi.hoisted(() => ({
  incrSpy: vi.fn(async (_key: string) => 1),
  state: {
    insertedRows: [] as Array<Record<string, unknown>>,
    updatedRows: [] as Array<Record<string, unknown>>,
    deletedRows: [] as Array<Record<string, unknown>>,
    selectRows: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock('@/lib/core/kv', () => ({
  incr: incrSpy,
  get: vi.fn(async () => null),
}));

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/core/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/db')>();
  return {
    ...actual,
    db: {
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve(state.insertedRows),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => Promise.resolve(state.updatedRows),
          }),
        }),
      }),
      delete: () => ({
        where: () => ({
          returning: () => Promise.resolve(state.deletedRows),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(state.selectRows),
          }),
        }),
      }),
    },
  };
});

import {
  createLongTermMemoryRow,
  deleteLongTermMemoryRow,
  deleteLongTermMemoriesByWorkspaceId,
  updateLongTermMemoryRow,
  upsertLongTermMemoryByKey,
} from '@/lib/core/db/memory/long-term';
import { sharedMemoryVersionKey } from '@/lib/memory/shared-version';

const WORKSPACE = 'workspace-dal-1';

function sharedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mem-1',
    userId: 'user-a',
    content: 'shared fact',
    shared: true,
    workspaceId: WORKSPACE,
    ...overrides,
  };
}

function bumpedKeys(): string[] {
  return incrSpy.mock.calls.map((call) => call[0] as string);
}

beforeEach(() => {
  incrSpy.mockClear();
  state.insertedRows = [];
  state.updatedRows = [];
  state.deletedRows = [];
  state.selectRows = [];
});

describe('createLongTermMemoryRow', () => {
  it('bumps the workspace version for a shared workspace-scoped row', async () => {
    state.insertedRows = [sharedRow()];

    await createLongTermMemoryRow('shared fact', {
      userId: 'user-a',
      workspaceId: WORKSPACE,
      shared: true,
    });

    expect(bumpedKeys()).toEqual([sharedMemoryVersionKey(WORKSPACE)]);
  });

  it('does NOT bump for a personal row (personal cache behavior unchanged)', async () => {
    state.insertedRows = [sharedRow({ shared: false })];

    await createLongTermMemoryRow('personal fact', {
      userId: 'user-a',
      workspaceId: WORKSPACE,
      shared: false,
    });

    expect(incrSpy).not.toHaveBeenCalled();
  });

  it('does NOT bump for a shared row without a workspace (global layer)', async () => {
    state.insertedRows = [sharedRow({ workspaceId: null })];

    await createLongTermMemoryRow('global fact', {
      userId: 'user-a',
      shared: true,
    });

    expect(incrSpy).not.toHaveBeenCalled();
  });
});

describe('upsertLongTermMemoryByKey', () => {
  it('bumps when the UPDATE path refreshes an already-shared row', async () => {
    state.selectRows = [{ id: 'mem-1' }];
    state.updatedRows = [sharedRow()];

    const result = await upsertLongTermMemoryByKey({
      userId: 'user-a',
      key: 'project.stack',
      content: 'new content',
      workspaceId: WORKSPACE,
    });

    expect(result.created).toBe(false);
    expect(bumpedKeys()).toEqual([sharedMemoryVersionKey(WORKSPACE)]);
  });

  it('does NOT bump when the UPDATE path touches a personal row', async () => {
    state.selectRows = [{ id: 'mem-1' }];
    state.updatedRows = [sharedRow({ shared: false })];

    await upsertLongTermMemoryByKey({
      userId: 'user-a',
      key: 'project.stack',
      content: 'new content',
      workspaceId: WORKSPACE,
    });

    expect(incrSpy).not.toHaveBeenCalled();
  });

  it('bumps when the INSERT path creates a shared row', async () => {
    state.selectRows = [];
    state.insertedRows = [sharedRow()];

    const result = await upsertLongTermMemoryByKey({
      userId: 'user-a',
      key: 'project.stack',
      content: 'shared fact',
      workspaceId: WORKSPACE,
      shared: true,
    });

    expect(result.created).toBe(true);
    expect(bumpedKeys()).toEqual([sharedMemoryVersionKey(WORKSPACE)]);
  });
});

describe('updateLongTermMemoryRow / deleteLongTermMemoryRow', () => {
  it('update bumps for a shared row', async () => {
    state.updatedRows = [sharedRow()];

    await updateLongTermMemoryRow('mem-1', 'rewritten content');

    expect(bumpedKeys()).toEqual([sharedMemoryVersionKey(WORKSPACE)]);
  });

  it('update does NOT bump for a personal row', async () => {
    state.updatedRows = [sharedRow({ shared: false })];

    await updateLongTermMemoryRow('mem-1', 'rewritten content');

    expect(incrSpy).not.toHaveBeenCalled();
  });

  it('delete bumps for a shared row', async () => {
    state.deletedRows = [sharedRow()];

    await deleteLongTermMemoryRow('mem-1');

    expect(bumpedKeys()).toEqual([sharedMemoryVersionKey(WORKSPACE)]);
  });

  it('delete does NOT bump for a personal row', async () => {
    state.deletedRows = [sharedRow({ shared: false })];

    await deleteLongTermMemoryRow('mem-1');

    expect(incrSpy).not.toHaveBeenCalled();
  });
});

describe('deleteLongTermMemoriesByWorkspaceId', () => {
  it('bumps unconditionally when rows were deleted (sharedOnly teardown)', async () => {
    state.deletedRows = [{ id: 'mem-1' }, { id: 'mem-2' }];

    const count = await deleteLongTermMemoriesByWorkspaceId(WORKSPACE, {
      sharedOnly: true,
    });

    expect(count).toBe(2);
    expect(bumpedKeys()).toEqual([sharedMemoryVersionKey(WORKSPACE)]);
  });

  it('bumps unconditionally on workspace hard delete', async () => {
    state.deletedRows = [{ id: 'mem-1' }];

    await deleteLongTermMemoriesByWorkspaceId(WORKSPACE);

    expect(bumpedKeys()).toEqual([sharedMemoryVersionKey(WORKSPACE)]);
  });

  it('does NOT bump when nothing was deleted', async () => {
    state.deletedRows = [];

    await deleteLongTermMemoriesByWorkspaceId(WORKSPACE);

    expect(incrSpy).not.toHaveBeenCalled();
  });
});
