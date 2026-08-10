'use client';

import { useQuery } from '@tanstack/react-query';
import { listRecentSessionsAction } from '@/app/(chat)/actions';
import { getQueryClient } from '@/components/react-query-provider';
import { useConfigContext } from '@/components/config/config-provider';
import { defaultStorage } from '@/lib/core/platform/storage';
import { useCallback, useEffect, useState } from 'react';

/**
 * Query key prefix for the user's recent chat sessions.
 *
 * Workspace-scoped: the full key is `['sessions', workspaceId]`. Callers
 * that want to invalidate every workspace's list pass the bare prefix
 * `['sessions']` (TanStack prefix match). Active-workspace tracking lives
 * in {@link useActiveWorkspace} below; this module owns only the query key.
 */
export const SESSION_LIST_KEY = ['sessions'] as const;

/**
 * Session list item shape as returned by listRecentSessionsAction and
 * consumed by both sidebar implementations. Kept here so dispatchers
 * (upsert helpers) and consumers share one definition.
 */
export interface SessionListItem {
  id: string;
  title: string | null;
  channel: string;
  createdAt: string;
  status?: string;
  pinned?: boolean;
  workspaceId?: string | null;
}

/**
 * Invalidate the session list query from ANY context (component,
 * server-action callback, SSE event handler, chat transport). Invalidates
 * every workspace's list (prefix match) so a session move/create touches
 * all views.
 */
export function invalidateSessionListQuery(): void {
  void getQueryClient().invalidateQueries({ queryKey: SESSION_LIST_KEY });
}

/**
 * Wipe the entire React Query cache (all queries, not just the session
 * list). Intended for logout / user-switch flows so stale session,
 * agentd-availability, and subagent-batch data does not survive the
 * auth change until a hard reload.
 */
export function clearSessionListCache(): void {
  getQueryClient().clear();
}

/**
 * Optimistically insert-or-update a session row in the cache.
 *
 * When the item's workspace is known, write ONLY to that workspace's list
 * (the precise key `['sessions', workspaceId]`) so the row does not leak
 * into every other workspace's cached list. When the workspace is unknown,
 * invalidate the prefix so the affected lists reload from the server rather
 * than stamping the same row into every group.
 */
export function upsertSessionListItemInCache(
  item: Pick<SessionListItem, 'id' | 'title' | 'channel' | 'createdAt'> & {
    status?: string;
    pinned?: boolean;
    workspaceId?: string | null;
  },
): void {
  const qc = getQueryClient();
  const writeRow = (list: SessionListItem[] | undefined) => {
    const current = list ?? [];
    const next: SessionListItem[] = [
      {
        id: item.id,
        title: item.title,
        channel: item.channel,
        createdAt: item.createdAt,
        status: item.status,
        pinned: item.pinned ?? false,
        workspaceId: item.workspaceId,
      },
      ...current.filter((s) => s.id !== item.id),
    ];
    return next.slice(0, 30);
  };

  // Known workspace → write only to its scoped key.
  if (item.workspaceId) {
    qc.setQueryData<SessionListItem[]>(
      ['sessions', item.workspaceId],
      writeRow,
    );
    return;
  }
  // Unknown workspace → don't guess; let the server re-prime every list.
  void qc.invalidateQueries({ queryKey: SESSION_LIST_KEY });
}

/**
 * Shared session-list query used by both sidebar implementations.
 *
 * Workspace-scoped via {@link useActiveWorkspace}. When the user switches
 * workspace, the key changes and TanStack refetches the new scope.
 *
 * Disabled while no workspace is selected (`workspaceId === null`): the
 * underlying `listSessions` only adds a `workspace_id` filter when given a
 * value, so an undefined workspace would return the user's sessions across
 * ALL workspaces mixed together. We wait for a concrete workspace instead.
 */
export function useSessionList(limit = 30) {
  const { workspaceId } = useActiveWorkspace();
  return useQuery<SessionListItem[]>({
    queryKey: ['sessions', workspaceId ?? null],
    enabled: !!workspaceId,
    queryFn: async () => {
      const rows = await listRecentSessionsAction({
        limit,
        workspaceId: workspaceId ?? undefined,
      });
      return rows as SessionListItem[];
    },
    staleTime: 30_000,
    refetchOnMount: true,
  });
}

// ─── Active workspace (client view state) ────────────────────────────

const ACTIVE_WORKSPACE_STORAGE_KEY = 'agentboster.activeWorkspaceId';

/**
 * Client-side "which workspace is the user currently looking at?" state.
 *
 * Persisted to localStorage (SSR-safe via the StorageAdapter) so a reload
 * keeps the user in the same workspace, and reset to null when the
 * authenticated user changes (userId guard). This is pure client view
 * state — the server is always the source of truth for which workspace a
 * session/memory actually belongs to.
 *
 * NOTE(tech-debt, follow-up): this currently uses local `useState`, so each
 * component calling `useActiveWorkspace()` gets its OWN instance. The
 * WorkspaceSwitcher and the session-list sidebar work today only because
 * the switcher's `handleSelect` navigates (`router.push`) and the sidebar
 * re-mounts, re-reading the persisted value from localStorage. If the
 * sidebar ever moves into a persistent layout (so it does NOT re-mount on
 * navigation) or multiple consumers coexist without a navigation, the two
 * instances would desync. The robust fix is a root-level shared store
 * (Zustand per AGENTS.md is the intended home, but it is not yet a
 * dependency — adding it is its own change) exposing one workspaceId across
 * all consumers, persisted via the same StorageAdapter. Tracked as a
 * follow-up; until then the localStorage + remount bridge keeps things
 * consistent in practice.
 */
export function useActiveWorkspace(): {
  workspaceId: string | null;
  setWorkspaceId: (id: string | null) => void;
} {
  const config = useConfigContext();
  const userId = config?.userId ?? null;
  const [workspaceId, setWorkspaceIdState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return defaultStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  });

  // Reset stored workspace when the authenticated user changes (login /
  // user-switch). Without this, a previous user's workspace id could
  // leak into the new session's queries until the user re-picks.
  useEffect(() => {
    if (!userId) return;
    const storedFor = defaultStorage.getItem(
      `${ACTIVE_WORKSPACE_STORAGE_KEY}.__user`,
    );
    if (storedFor && storedFor !== userId) {
      defaultStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
      setWorkspaceIdState(null);
    }
    defaultStorage.setItem(`${ACTIVE_WORKSPACE_STORAGE_KEY}.__user`, userId);
  }, [userId]);

  const setWorkspaceId = useCallback((id: string | null) => {
    setWorkspaceIdState(id);
    if (id) {
      defaultStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, id);
    } else {
      defaultStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
    }
  }, []);

  return { workspaceId, setWorkspaceId };
}
