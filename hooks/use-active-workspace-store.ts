'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';
import { defaultStorage } from '@/lib/core/platform/storage';

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
 * StateStorage wrapper around the project StorageAdapter with one-time
 * migration of the pre-zustand format: the key used to hold a bare
 * workspace-id string (plus a `.__user` sibling recording the owner).
 * A bare id is not valid JSON, so on parse failure we convert it into the
 * persist blob shape and drop the sibling key.
 */
const legacyAwareStorage: StateStorage = {
  getItem: (name) => {
    const raw = defaultStorage.getItem(name);
    if (raw === null) return null;
    try {
      JSON.parse(raw);
      return raw;
    } catch {
      const legacyUser = defaultStorage.getItem(`${name}.__user`);
      defaultStorage.removeItem(`${name}.__user`);
      return JSON.stringify({
        state: { workspaceId: raw, userId: legacyUser },
        version: 0,
      });
    }
  },
  setItem: (name, value) => {
    defaultStorage.setItem(name, value);
  },
  removeItem: (name) => {
    defaultStorage.removeItem(name);
  },
};

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
