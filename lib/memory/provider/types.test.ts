import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROVIDER_ID,
  type CompactCapability,
  type IngestCapability,
  type MemoryProvider,
  type MemoryVersionCapability,
  type SourceSyncCapability,
  hasCompact,
  hasIngest,
  hasMemoryVersion,
  hasSourceSync,
} from './types';

describe('provider/types', () => {
  describe('DEFAULT_PROVIDER_ID', () => {
    it('matches memoh 的虚拟兜底 id 约定', () => {
      // 借鉴 memoh DefaultBuiltinProviderID = "__builtin__"
      expect(DEFAULT_PROVIDER_ID).toBe('__builtin__');
    });
  });

  describe('类型守卫', () => {
    it('检测到已实现的能力', () => {
      const full = {
        type: 'builtin' as const,
        id: 'test',
        search: async () => [],
        add: async () => ({ id: '1', key: 'k' }),
        update: async () => {},
        delete: async () => {},
        compact: async () => ({ before: 0, after: 0, retiredIds: [] }),
        ingest: async () => ({ ingested: 0, skipped: 0 }),
        rebuild: async () => ({ ok: true }),
        memoryVersion: async () => 1,
      } satisfies MemoryProvider &
        CompactCapability &
        IngestCapability &
        SourceSyncCapability &
        MemoryVersionCapability;

      expect(hasCompact(full)).toBe(true);
      expect(hasIngest(full)).toBe(true);
      expect(hasSourceSync(full)).toBe(true);
      expect(hasMemoryVersion(full)).toBe(true);
    });

    it('未实现的能力返回 false(避免空壳方法)', () => {
      // 关键性质:外部后端不实现 = 不具备能力,不必写 throw unsupported
      const minimal: MemoryProvider = {
        type: 'mem0',
        id: 'mem0-1',
        search: async () => [],
        add: async () => ({ id: '1', key: 'k' }),
        update: async () => {},
        delete: async () => {},
      };

      expect(hasCompact(minimal)).toBe(false);
      expect(hasIngest(minimal)).toBe(false);
      expect(hasSourceSync(minimal)).toBe(false);
      expect(hasMemoryVersion(minimal)).toBe(false);
    });
  });
});
