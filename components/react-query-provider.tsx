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
 * Module-level singleton QueryClient.
 *
 * Created once per browser session (and once per SSR pass on the server)
 * so non-component code paths — session-events dispatchers, session
 * bootstrap, etc. — can reach the
 * cache via {@link getQueryClient} to invalidate queries. The provider
 * below mounts this same instance under the React tree.
 *
 * Why a singleton over `useQueryClient()`: hooks only work inside the
 * React render cycle. The dispatch sites fire from SSE event handlers,
 * server-action success callbacks, and chat-transport message streams —
 * none of which are React components. The singleton lets them invalidate
 * the same cache the components read.
 *
 * Defaults follow Multica's battle-tested policy (ref:
 * ref/packages/core/query-client.ts): never refetch queries with active
 * observers on window refocus (chat sessions are read-often and refetch
 * fights with optimistic stream state), retry transient failures twice,
 * and surface unhandled query errors to the server logger so they don't
 * silently rot in a devtools tab.
 */
let clientSingleton: QueryClient | null = null;

function createQueryClient(): QueryClient {
  return new QueryClient({
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
  });
}

export function getQueryClient(): QueryClient {
  // On the server, always return a fresh instance so each SSR request
  // gets an isolated cache (a module singleton would leak data across
  // concurrent SSR requests in a long-lived Node process).
  if (typeof window === 'undefined') return createQueryClient();
  if (!clientSingleton) clientSingleton = createQueryClient();
  return clientSingleton;
}

/**
 * Global React Query boundary.
 *
 * Mounted once at the root layout so every route group (chat, config,
 * memory, skills, ...) shares the singleton client. Previously this
 * provider only wrapped /config; other routes couldn't useQuery and
 * fell back to useEffect+fetch + window CustomEvent pub/sub.
 * Centralizing here is the foundation for migrating those ad-hoc data
 * paths to React Query.
 */
export function ReactQueryProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // useState initializer calls getQueryClient(), which returns a fresh
  // client per SSR render (no cross-request leak) and the persistent
  // module singleton in the browser.
  const [client] = useState(() => getQueryClient());

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
