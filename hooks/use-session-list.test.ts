/**
 * Tests for {@link upsertSessionListItemInCache} — the optimistic
 * insert-or-update helper for the session list cache.
 *
 * Regression covered: rebuilding a row used to drop the access
 * annotations (`visibility`, `manageOnly`, `isOwn`) that
 * listRecentSessionsAction computed, so an optimistic upsert (rename,
 * first-message title) silently unlocked/relabeled rows until the next
 * refetch. The helper now falls back to the existing row's values when
 * the incoming item doesn't carry them.
 *
 * Run via: yarn test hooks/use-session-list.test.ts
 */

import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const qc = new QueryClient();

vi.mock('@/components/react-query-provider', () => ({
  getQueryClient: () => qc,
}));
// The hook module also imports the server action and config context for
// the query path — replace them so this test stays client-only.
vi.mock('@/app/(chat)/actions', () => ({
  listRecentSessionsAction: vi.fn(),
}));
vi.mock('@/components/config/config-provider', () => ({
  useConfigContext: () => null,
}));

import {
  SESSION_LIST_KEY,
  type SessionListItem,
  upsertSessionListItemInCache,
} from './use-session-list';

const USER_ID = 'user-1';
const WS_ID = 'ws-1';
const KEY = [...SESSION_LIST_KEY, USER_ID, WS_ID] as const;

function seedList(rows: SessionListItem[]) {
  qc.setQueryData<SessionListItem[]>(KEY, rows);
}

function readList(): SessionListItem[] {
  return qc.getQueryData<SessionListItem[]>(KEY) ?? [];
}

function makeRow(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: 's-1',
    title: 'Existing',
    channel: 'web',
    createdAt: '2025-01-01T00:00:00.000Z',
    workspaceId: WS_ID,
    ...overrides,
  };
}

beforeEach(() => {
  qc.clear();
  vi.restoreAllMocks();
});

describe('upsertSessionListItemInCache', () => {
  it('preserves visibility/manageOnly/isOwn of the existing row when the upsert omits them', () => {
    seedList([
      makeRow({
        visibility: 'shared',
        manageOnly: true,
        isOwn: false,
      }),
    ]);

    upsertSessionListItemInCache(
      {
        id: 's-1',
        title: 'Renamed',
        channel: 'web',
        createdAt: '2025-01-02T00:00:00.000Z',
        workspaceId: WS_ID,
      },
      USER_ID,
    );

    const [row] = readList();
    expect(row.title).toBe('Renamed');
    expect(row.visibility).toBe('shared');
    expect(row.manageOnly).toBe(true);
    expect(row.isOwn).toBe(false);
  });

  it('lets explicit incoming values override the existing row', () => {
    seedList([
      makeRow({ visibility: 'private', manageOnly: true, isOwn: false }),
    ]);

    upsertSessionListItemInCache(
      {
        id: 's-1',
        title: 'Renamed',
        channel: 'web',
        createdAt: '2025-01-02T00:00:00.000Z',
        workspaceId: WS_ID,
        visibility: 'shared',
        manageOnly: false,
        isOwn: true,
      },
      USER_ID,
    );

    const [row] = readList();
    expect(row.visibility).toBe('shared');
    expect(row.manageOnly).toBe(false);
    expect(row.isOwn).toBe(true);
  });

  it('inserts a new row at the front with pinned defaulting to false', () => {
    seedList([makeRow({ id: 's-older' })]);

    upsertSessionListItemInCache(
      {
        id: 's-new',
        title: 'New chat',
        channel: 'web',
        createdAt: '2025-01-03T00:00:00.000Z',
        workspaceId: WS_ID,
      },
      USER_ID,
    );

    const list = readList();
    expect(list.map((r) => r.id)).toEqual(['s-new', 's-older']);
    expect(list[0].pinned).toBe(false);
    expect(list[0].visibility).toBeUndefined();
  });

  it('keeps the cached list capped at 30 rows', () => {
    seedList(
      Array.from({ length: 30 }, (_, i) =>
        makeRow({
          id: `s-${i}`,
          createdAt: `2025-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        }),
      ),
    );

    upsertSessionListItemInCache(
      {
        id: 's-new',
        title: 'New chat',
        channel: 'web',
        createdAt: '2025-01-03T00:00:00.000Z',
        workspaceId: WS_ID,
      },
      USER_ID,
    );

    const list = readList();
    expect(list).toHaveLength(30);
    expect(list[0].id).toBe('s-new');
    expect(list.some((r) => r.id === 's-29')).toBe(false);
  });

  it('invalidates the prefix instead of writing when the workspace is unknown', () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const setSpy = vi.spyOn(qc, 'setQueryData');

    upsertSessionListItemInCache(
      {
        id: 's-1',
        title: 'No workspace',
        channel: 'web',
        createdAt: '2025-01-02T00:00:00.000Z',
      },
      USER_ID,
    );

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: SESSION_LIST_KEY,
    });
    expect(setSpy).not.toHaveBeenCalled();
  });
});
