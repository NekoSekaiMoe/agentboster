/**
 * Storage abstraction so client code never touches `localStorage` directly.
 *
 * Why: inline `typeof window !== 'undefined' ? localStorage...` guards
 * sprinkled through hooks/components are fragile under Next.js SSR, RSC
 * serialization, and tests. Routing through a single adapter removes the
 * guards and makes the storage mockable in tests. Ported from Multica
 * (`ref/packages/core/types/storage.ts` +
 * `ref/packages/core/platform/storage.ts`).
 */
export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * SSR-safe localStorage. Returns null and drops writes when window is
 * undefined (server render, tests). Use this everywhere instead of the
 * global `localStorage` so client code is render-safe by construction.
 */
export const defaultStorage: StorageAdapter = {
  getItem: (k) =>
    typeof window !== 'undefined' ? window.localStorage.getItem(k) : null,
  setItem: (k, v) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(k, v);
  },
  removeItem: (k) => {
    if (typeof window !== 'undefined') window.localStorage.removeItem(k);
  },
};

/**
 * In-memory StorageAdapter for tests. Matches the StorageAdapter signature
 * so any consumer that takes an adapter can be tested without jsdom.
 */
export function createMemoryStorage(): StorageAdapter & {
  __store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    __store: store,
    getItem: (k) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k, v) => {
      store.set(k, v);
    },
    removeItem: (k) => {
      store.delete(k);
    },
  };
}
