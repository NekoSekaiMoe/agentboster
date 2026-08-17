'use client';

import { useQuery } from '@tanstack/react-query';

import { fetchIdentity, type Identity } from '@/lib/core/api/identity';

/**
 * Authenticated identity for client chrome that renders outside the
 * /config subtree. ConfigProvider (full config draft + runtime health) is
 * only mounted under /config, so chat surfaces must NOT read
 * userId/isAdmin from `useConfigContext()` — it is null there, which
 * historically left the session list permanently disabled. This hook hits
 * GET /api/auth/me instead.
 *
 * Cached under ['auth', 'me']; logout / user-switch flows wipe the whole
 * query cache via clearSessionListCache(), so a stale identity cannot
 * leak across accounts.
 */
export function useIdentity() {
  const query = useQuery<Identity | null>({
    queryKey: ['auth', 'me'],
    queryFn: fetchIdentity,
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return {
    identity: query.data ?? null,
    isLoading: query.isLoading,
    userId: query.data?.userId ?? null,
    isAdmin: query.data?.isAdmin ?? false,
  };
}
