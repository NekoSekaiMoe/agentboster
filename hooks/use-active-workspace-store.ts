'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';
import { defaultStorage } from '@/lib/core/platform/storage';
import type { StorageAdapter } from '@/lib/core/platform/storage';

/**
 * localStorage key for the persisted active-workspace blob. Kept identical
 * to the pre-zustand key so existing users migrate in place (see
 * {@link legacyAwareStorage}).
 */
const ACTIVE_WORKSPACE_STORAGE_KEY = 'agentboster.activeWorkspaceId';

interface ActiveWorkspaceState {
  /** Currently selected workspace, or null when none is known yet. */
  workspaceId: string | null;
  /**
   * Authenticated user the stored workspaceId belongs to. Tracked so a
   * login / user-switch clears the previous user's workspace instead of
   * leaking it into the new session's queries.
   */
  userId: string | null;
  setWorkspaceId: (id: string | null) => void;
  /**
   * Record the authenticated user. When the id CHANGES from a previous
   * non-null value, the stored workspace is cleared in the same update so
   * no consumer ever observes a cross-user pair.
   */
  setUserId: (id: string | null) => void;
}

/**
 * zustand v5 persist blob conventions: createJSONStorage stringifies
 * `{ state, version }`; on read, persist calls the StateStorage getItem,
 * JSON-parses the result, and only treats it as a persisted snapshot when
 * `.state` is present (`version` is consulted for migrate only when it is
 * a number). Anything else must not be handed back unchanged — a JSON
 * `null`, primitive, or malformed object would be surfaced to zustand as
 * if it were a valid snapshot.
 */
function isPersistBlob(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return false;
  const blob = value as { state?: unknown; version?: unknown };
  if (typeof blob.state !== 'object' || blob.state === null) return false;
  // Arrays are objects (`typeof [] === 'object'`) but are never a valid
  // persisted state — `{state: [], version: 0}` must not pass.
  if (Array.isArray(blob.state)) return false;
  // version is optional; when present it must be a number (zustand's
  // migrate hook only runs on numeric versions).
  return blob.version === undefined || typeof blob.version === 'number';
}

/**
 * Migrate a pre-zustand record into the persist blob shape: the key used
 * to hold a bare workspace-id string, with a `.__user` sibling recording
 * the owner. Consumes (removes) the sibling key and writes the migrated
 * blob back to the primary key so repeat loads hit the valid-blob path
 * with the migrated userId intact.
 */
function migrateLegacy(
  adapter: StorageAdapter,
  name: string,
  workspaceId: string,
): string {
  const legacyUser = adapter.getItem(`${name}.__user`);
  adapter.removeItem(`${name}.__user`);
  const blob = JSON.stringify({
    state: { workspaceId, userId: legacyUser },
    version: 0,
  });
  // Write the migrated blob back to the primary key BEFORE returning it.
  // Without this, a second load that happens before any zustand set()
  // persists would re-enter migration with the `__user` sibling already
  // consumed and silently lose the userId.
  adapter.setItem(name, blob);
  return blob;
}

/**
 * StateStorage factory wrapping a project StorageAdapter with one-time
 * migration of the pre-zustand format (see {@link migrateLegacy}).
 *
 * Read semantics:
 *  - missing key            → null (no state)
 *  - valid persist blob     → returned unchanged
 *  - bare legacy id         → parse failure: migrate in place (raw string)
 *  - JSON string primitive  → still a meaningful legacy id: migrate
 *  - JSON null / non-string primitive / malformed object → NOT a usable
 *    workspace id: drop the key (and stale sibling) and return null.
 */
export function createLegacyAwareStorage(
  adapter: StorageAdapter,
): StateStorage {
  return {
    getItem: (name) => {
      const raw = adapter.getItem(name);
      if (raw === null) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Bare legacy id (not valid JSON) — the classic pre-zustand shape.
        return migrateLegacy(adapter, name, raw);
      }
      if (isPersistBlob(parsed)) return raw;
      // Parsed successfully but not a persist blob. A JSON string can
      // still be a meaningful legacy workspace id; null / numbers /
      // booleans / malformed objects cannot.
      if (typeof parsed === 'string' && parsed.length > 0) {
        return migrateLegacy(adapter, name, parsed);
      }
      adapter.removeItem(name);
      adapter.removeItem(`${name}.__user`);
      return null;
    },
    setItem: (name, value) => {
      adapter.setItem(name, value);
    },
    removeItem: (name) => {
      adapter.removeItem(name);
    },
  };
}

const legacyAwareStorage: StateStorage =
  createLegacyAwareStorage(defaultStorage);

/**
 * Shared active-workspace store. Single source of truth for "which
 * workspace is the user looking at?" across ALL consumers (workspace
 * switcher, session list, sidebar) — replaces the per-hook `useState`
 * instances that desynced unless a navigation forced a remount.
 *
 * Persisted via zustand/middleware `persist` backed by the project
 * StorageAdapter (never localStorage directly, per AGENTS.md). This is
 * pure client view state; the server remains the source of truth for
 * which workspace a session/memory actually belongs to.
 */
export const useActiveWorkspaceStore = create<ActiveWorkspaceState>()(
  persist(
    (set, get) => ({
      workspaceId: null,
      userId: null,
      setWorkspaceId: (id) => {
        set({ workspaceId: id });
      },
      setUserId: (id) => {
        if (!id) return;
        const previous = get().userId;
        if (previous && previous !== id) {
          // User switch: clear the previous user's workspace atomically.
          set({ userId: id, workspaceId: null });
        } else if (previous !== id) {
          set({ userId: id });
        }
      },
    }),
    {
      name: ACTIVE_WORKSPACE_STORAGE_KEY,
      storage: createJSONStorage(() => legacyAwareStorage),
      partialize: (state) => ({
        workspaceId: state.workspaceId,
        userId: state.userId,
      }),
    },
  ),
);
