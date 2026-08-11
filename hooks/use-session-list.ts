'use client';

import { useQuery } from '@tanstack/react-query';
import { listRecentSessionsAction } from '@/app/(chat)/actions';
import { getQueryClient } from '@/components/react-query-provider';
import { useConfigContext } from '@/components/config/config-provider';
import { useActiveWorkspaceStore } from '@/hooks/use-active-workspace-store';
import { useEffect } from 'react';

/**
 * Query key prefix for the user's recent chat sessions.
 *
 * Workspace- and user-scoped: the full key is
 * `['sessions', userId, workspaceId]`. Callers that want to invalidate
 * every list pass the bare prefix `['sessions']` (TanStack prefix match).
 * Active-workspace tracking lives in {@link useActiveWorkspace} below;
 * this module owns only the query key.
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
  /** Session visibility inside a public workspace ('private'|'shared'). */
  visibility?: 'private' | 'shared';
  /** True when the actor may manage (rename/delete) but NOT read the
   *  conversation — other members' private sessions in a workspace the
   *  actor manages. The UI renders a lock instead of a chat link. */
  manageOnly?: boolean;
  /** True when the session was created by the current user. */
  isOwn?: boolean;
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
 * (the precise key `['sessions', userId, workspaceId]`, identical to the
 * key used by {@link useSessionList}) so the row does not leak into every
 * other workspace's cached list. When the workspace is unknown,
 * invalidate the prefix so the affected lists reload from the server rather
 * than stamping the same row into every group.
 *
 * `userId` is normally read from the active-workspace store (kept current
 * by {@link useActiveWorkspace}); callers that already hold the id may
 * pass it explicitly.
 */
export function upsertSessionListItemInCache(
  item: Pick<SessionListItem, 'id' | 'title' | 'channel' | 'createdAt'> & {
    status?: string;
    pinned?: boolean;
    workspaceId?: string | null;
    visibility?: 'private' | 'shared';
    manageOnly?: boolean;
    isOwn?: boolean;
  },
  userId?: string | null,
): void {
  const qc = getQueryClient();
  const writeRow = (list: SessionListItem[] | undefined) => {
    const current = list ?? [];
    const existing = current.find((s) => s.id === item.id);
    const next: SessionListItem[] = [
      {
        id: item.id,
        title: item.title,
        channel: item.channel,
        createdAt: item.createdAt,
        status: item.status ?? existing?.status,
        pinned: item.pinned ?? existing?.pinned ?? false,
        workspaceId: item.workspaceId ?? existing?.workspaceId,
        // Rebuilding the row must not strip access annotations the list
        // query already computed — fall back to the existing row's values
        // when the incoming upsert doesn't carry them.
        visibility: item.visibility ?? existing?.visibility,
        manageOnly: item.manageOnly ?? existing?.manageOnly,
        isOwn: item.isOwn ?? existing?.isOwn,
      },
      ...current.filter((s) => s.id !== item.id),
    ];
    return next.slice(0, 30);
  };

  // Known workspace → write only to its user-scoped key (identical shape
  // to useSessionList's queryKey). The userId falls back to the shared
  // store so callers without the id in scope still hit the right key.
  if (item.workspaceId) {
    const effectiveUserId =
      userId !== undefined ? userId : useActiveWorkspaceStore.getState().userId;
    qc.setQueryData<SessionListItem[]>(
      ['sessions', effectiveUserId, item.workspaceId],
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
 * Workspace-scoped via {@link useActiveWorkspace} and user-scoped via the
 * config context, so the cache is per user+workspace. When either scope
 * changes, the key changes and TanStack refetches the new scope.
 *
 * Disabled until BOTH a workspace and a user id are known: the underlying
 * `listSessions` only adds a `workspace_id` filter when given a value, so
 * an undefined workspace would return the user's sessions across ALL
 * workspaces mixed together, and a null user id would cache the result
 * under the wrong scope. We wait for both instead.
 */
export function useSessionList(limit = 30) {
  const { workspaceId } = useActiveWorkspace();
  const config = useConfigContext();
  const userId = config?.userId ?? null;
  return useQuery<SessionListItem[]>({
    queryKey: ['sessions', userId, workspaceId ?? null],
    enabled: !!workspaceId && !!userId,
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

/**
 * Client-side "which workspace is the user currently looking at?" state.
 *
 * Backed by the shared persisted Zustand store in
 * `@/hooks/use-active-workspace-store`, so EVERY consumer observes the
 * same workspaceId immediately after any `setWorkspaceId` call — no
 * per-component `useState` copies that only resync via navigation
 * remounts. Persisted (SSR-safe via the project StorageAdapter) so a
 * reload keeps the user in the same workspace, and cleared when the
 * authenticated user changes (handled inside the store's `setUserId`).
 * This is pure client view state — the server is always the source of
 * truth for which workspace a session/memory actually belongs to.
 */
export function useActiveWorkspace(): {
  workspaceId: string | null;
  setWorkspaceId: (id: string | null) => void;
} {
  const config = useConfigContext();
  const userId = config?.userId ?? null;
  const workspaceId = useActiveWorkspaceStore((s) => s.workspaceId);
  const setWorkspaceId = useActiveWorkspaceStore((s) => s.setWorkspaceId);
  const setUserId = useActiveWorkspaceStore((s) => s.setUserId);

  // Record the authenticated user in the store. On a user CHANGE (login /
  // user-switch) the store clears the stored workspace in the same update,
  // so a previous user's workspace id can never leak into the new
  // session's queries.
  useEffect(() => {
    setUserId(userId);
  }, [userId, setUserId]);

  return { workspaceId, setWorkspaceId };
}
