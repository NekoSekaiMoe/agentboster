'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { listRecentSessionsAction } from '@/app/(chat)/actions';
import {
  SESSION_LIST_INVALIDATED_EVENT,
  SESSION_LIST_UPSERTED_EVENT,
  type SessionListItemEventDetail,
} from '@/lib/chat/session-events';

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
 * Shared session-list query used by both sidebar implementations.
 *
 * Replaces the per-component `useEffect + listRecentSessionsAction +
 * useState` + `window.addEventListener(SESSION_LIST_*)` pattern with a
 * single useQuery. The CustomEvent bus (`lib/chat/session-events.ts`)
 * is still the invalidation signal — dispatchers call
 * `invalidateSessionList()` / `upsertSessionListItem()` as before, and
 * this hook translates those events into Query cache invalidations /
 * optimistic patches. This is an adapter bridge: the bus carries no
 * data the Query cache doesn't already own, so a future refactor can
 * retire the bus entirely by having dispatchers call
 * `qc.invalidateQueries(SESSION_LIST_KEY)` directly.
 */
export function useSessionList(limit = 30) {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: SESSION_LIST_KEY,
    queryFn: () => listRecentSessionsAction(limit),
    staleTime: 30_000,
  });

  // Bridge: translate the legacy CustomEvent bus into Query cache ops.
  // INVALIDATED → refetch; UPSERTED → optimistic patch (prepend + dedupe).
  useEffect(() => {
    const handleInvalidated = () => {
      void qc.invalidateQueries({ queryKey: SESSION_LIST_KEY });
    };
    const handleUpserted = (event: Event) => {
      const detail = (event as CustomEvent<SessionListItemEventDetail>).detail;
      if (!detail) return;
      qc.setQueryData<typeof query.data>(SESSION_LIST_KEY, (current) => {
        const list = current ?? [];
        const next = [
          {
            id: detail.id,
            title: detail.title,
            channel: detail.channel,
            createdAt: detail.createdAt,
            pinned: false,
          },
          ...list.filter((s) => s.id !== detail.id),
        ];
        return next.slice(0, limit) as typeof query.data;
      });
    };

    window.addEventListener(SESSION_LIST_INVALIDATED_EVENT, handleInvalidated);
    window.addEventListener(SESSION_LIST_UPSERTED_EVENT, handleUpserted);
    return () => {
      window.removeEventListener(
        SESSION_LIST_INVALIDATED_EVENT,
        handleInvalidated,
      );
      window.removeEventListener(SESSION_LIST_UPSERTED_EVENT, handleUpserted);
    };
  }, [qc, limit]);

  return query;
}
