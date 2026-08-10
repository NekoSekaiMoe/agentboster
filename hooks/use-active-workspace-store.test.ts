/**
 * Tests for {@link createLegacyAwareStorage} — the zustand StateStorage
 * wrapper that migrates the pre-zustand persistence format of the active
 * workspace key.
 *
 * Covered read semantics:
 *  - missing key                       → null
 *  - valid `{state, version}` blob     → returned unchanged
 *  - bare legacy id (invalid JSON)     → migrated in place (existing path)
 *  - JSON string primitive             → still a legacy id: migrated
 *  - JSON null / non-string primitive  → key dropped, null
 *  - malformed objects                 → key dropped, null
 *
 * Run via: yarn test hooks/use-active-workspace-store.test.ts
 */

import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '@/lib/core/platform/storage';
import { createLegacyAwareStorage } from './use-active-workspace-store';

const KEY = 'agentboster.activeWorkspaceId';
const USER_KEY = `${KEY}.__user`;

function setup() {
  const adapter = createMemoryStorage();
  const storage = createLegacyAwareStorage(adapter);
  return { adapter, storage };
}

describe('createLegacyAwareStorage.getItem', () => {
  it('returns null for a missing key', () => {
    const { storage } = setup();
    expect(storage.getItem(KEY)).toBeNull();
  });

  it('returns a valid persist blob unchanged', () => {
    const { adapter, storage } = setup();
    const blob = JSON.stringify({
      state: { workspaceId: 'ws-1', userId: 'u-1' },
      version: 0,
    });
    adapter.setItem(KEY, blob);
    expect(storage.getItem(KEY)).toBe(blob);
    // No migration side effects.
    expect(adapter.getItem(KEY)).toBe(blob);
  });

  it('accepts a blob with a higher numeric version (zustand migrate handles it)', () => {
    const { adapter, storage } = setup();
    const blob = JSON.stringify({
      state: { workspaceId: 'ws-1' },
      version: 3,
    });
    adapter.setItem(KEY, blob);
    expect(storage.getItem(KEY)).toBe(blob);
  });

  it('migrates a bare legacy id (invalid JSON) and consumes the __user sibling', () => {
    const { adapter, storage } = setup();
    adapter.setItem(KEY, 'ws-legacy-42');
    adapter.setItem(USER_KEY, 'u-legacy');
    const result = storage.getItem(KEY);
    expect(JSON.parse(result as string)).toEqual({
      state: { workspaceId: 'ws-legacy-42', userId: 'u-legacy' },
      version: 0,
    });
    expect(adapter.getItem(USER_KEY)).toBeNull();
  });

  it('migrates a bare legacy id without a __user sibling (userId null)', () => {
    const { adapter, storage } = setup();
    adapter.setItem(KEY, 'ws-legacy-42');
    const result = storage.getItem(KEY);
    expect(JSON.parse(result as string)).toEqual({
      state: { workspaceId: 'ws-legacy-42', userId: null },
      version: 0,
    });
  });

  it('migrates a JSON string primitive as a meaningful legacy id', () => {
    const { adapter, storage } = setup();
    adapter.setItem(KEY, JSON.stringify('ws-quoted'));
    adapter.setItem(USER_KEY, 'u-legacy');
    const result = storage.getItem(KEY);
    expect(JSON.parse(result as string)).toEqual({
      state: { workspaceId: 'ws-quoted', userId: 'u-legacy' },
      version: 0,
    });
    expect(adapter.getItem(USER_KEY)).toBeNull();
  });

  it('drops the key and returns null for JSON null', () => {
    const { adapter, storage } = setup();
    adapter.setItem(KEY, 'null');
    adapter.setItem(USER_KEY, 'u-stale');
    expect(storage.getItem(KEY)).toBeNull();
    expect(adapter.getItem(KEY)).toBeNull();
    expect(adapter.getItem(USER_KEY)).toBeNull();
  });

  it.each(['42', 'true', '3.14'])(
    'drops the key and returns null for non-string primitive %s',
    (raw) => {
      const { adapter, storage } = setup();
      adapter.setItem(KEY, raw);
      expect(storage.getItem(KEY)).toBeNull();
      expect(adapter.getItem(KEY)).toBeNull();
    },
  );

  it('drops the key and returns null for an empty JSON string', () => {
    const { adapter, storage } = setup();
    adapter.setItem(KEY, '""');
    expect(storage.getItem(KEY)).toBeNull();
    expect(adapter.getItem(KEY)).toBeNull();
  });

  it.each([
    ['object without state', '{"foo":1}'],
    ['array', '[1,2,3]'],
    ['state not an object', '{"state":"ws-1","version":0}'],
    ['null state', '{"state":null,"version":0}'],
    ['non-numeric version', '{"state":{"workspaceId":"ws-1"},"version":"0"}'],
  ])(
    'drops the key and returns null for a malformed blob: %s',
    (_label, raw) => {
      const { adapter, storage } = setup();
      adapter.setItem(KEY, raw);
      expect(storage.getItem(KEY)).toBeNull();
      expect(adapter.getItem(KEY)).toBeNull();
    },
  );
});

describe('createLegacyAwareStorage set/remove passthrough', () => {
  it('delegates setItem/removeItem to the underlying adapter', () => {
    const { adapter, storage } = setup();
    storage.setItem(KEY, 'blob');
    expect(adapter.getItem(KEY)).toBe('blob');
    storage.removeItem(KEY);
    expect(adapter.getItem(KEY)).toBeNull();
  });
});
