'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listRecentSessionsAction } from '@/app/(chat)/actions';
import { getQueryClient } from '@/components/react-query-provider';

/**
 * Query key for the user's recent chat sessions.
 *
 * Workspace-scoped data includes the scope id in the key per AGENTS.md;
 * agentboster is single-user so there's no workspace dimension yet, but
 * the array form keeps the door open. Invalidation callers use
 * `qc.invalidateQueries({ queryKey: SESSION_LIST_KEY })` (prefix match).
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
}

/**
 * Invalidate the session list query from ANY context (component,
 * server-action callback, SSE event handler, chat transport).
 *
 * This replaces the prior `invalidateSessionList()` window-CustomEvent
 * bus helper. Non-component callers reach the cache via the module
 * singleton ({@link getQueryClient}); component callers can also use
 * `useQueryClient().invalidateQueries(...)` directly.
 */
export function invalidateSessionListQuery(): void {
  void getQueryClient().invalidateQueries({ queryKey: SESSION_LIST_KEY });
}

/**
 * Optimistically insert-or-update a session row in the cache. Used when
 * a new conversation is created lazily on first message — prepending
 * it to the sidebar without a full refetch. Replaces the prior
 * `upsertSessionListItem()` window-CustomEvent bus helper.
 */
export function upsertSessionListItemInCache(
  item: Pick<SessionListItem, 'id' | 'title' | 'channel' | 'createdAt'> & {
    status?: string;
    pinned?: boolean;
  },
): void {
  const qc = getQueryClient();
  qc.setQueryData<SessionListItem[]>(SESSION_LIST_KEY, (current) => {
    const list = current ?? [];
    const next: SessionListItem[] = [
      {
        id: item.id,
        title: item.title,
        channel: item.channel,
        createdAt: item.createdAt,
        status: item.status,
        pinned: item.pinned ?? false,
      },
      ...list.filter((s) => s.id !== item.id),
    ];
    return next.slice(0, 30);
  });
}

/**
 * Shared session-list query used by both sidebar implementations.
 *
 * Replaces the per-component `useEffect + listRecentSessionsAction +
 * useState` pattern with a single useQuery. Invalidation and optimistic
 * upsert happen through {@link invalidateSessionListQuery} and
 * {@link upsertSessionListItemInCache} — no window event bus.
 */
export function useSessionList(limit = 30) {
  const qc = useQueryClient();
  void qc; // (kept for symmetry with the module-level helpers; this hook does
  // not invalidate directly — dispatchers use invalidateSessionListQuery.)
  return useQuery<SessionListItem[]>({
    queryKey: SESSION_LIST_KEY,
    queryFn: async () => {
      const rows = await listRecentSessionsAction(limit);
      // listRecentSessionsAction returns {id,title,channel,createdAt,
      // pinned}; status is absent (it's patched in from the separate
      // /api/agentd/v1/sessions/status poll in sidebar-core). Cast to
      // SessionListItem[] so consumers reading session.status type-check;
      // the field stays undefined until something upserts it.
      return rows as SessionListItem[];
    },
    staleTime: 30_000,
    refetchOnMount: true,
  });
}
