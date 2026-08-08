'use client';

import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { useState } from 'react';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('react-query');

/**
 * Global React Query boundary.
 *
 * Mounted once at the root layout so every route group (chat, config,
 * memory, skills, ...) shares the same client. Previously this provider
 * only wrapped /config; other routes couldn't useQuery and fell back to
 * useEffect+fetch + window CustomEvent pub/sub. Centralizing here is the
 * foundation for migrating those ad-hoc data paths to React Query.
 *
 * Defaults follow Multica's battle-tested policy (ref:
 * ref/packages/core/query-client.ts): never refetch queries with active
 * observers on window refocus (chat sessions are read-often and refetch
 * fights with optimistic stream state), retry transient failures twice,
 * and surface unhandled query errors to the server logger so they don't
 * silently rot in a devtools tab.
 */
export function ReactQueryProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 2,
          },
          mutations: {
            retry: 0,
          },
        },
        queryCache: new QueryCache({
          onError: (error, query) => {
            logger.warn('query:error', {
              queryKey: query.queryKey,
              message: error instanceof Error ? error.message : String(error),
            });
          },
        }),
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
