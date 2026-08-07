import { afterEach, describe, expect, it } from 'vitest';

import type { MemoryProvider, MemoryProviderFactory } from './types';
import {
  clearRegistryForTests,
  evictProvider,
  getProvider,
  registerFactory,
  registrySize,
} from './registry';

// ─── 测试用 stub provider ──────────────────────────────────────────

function makeStubProvider(id: string, marker: string): MemoryProvider {
  return {
    type: 'builtin',
    id,
    search: async () => [
      { memoryId: marker, key: marker, content: marker, score: 1 },
    ],
    add: async () => ({ id: marker, key: marker }),
    update: async () => {},
    delete: async () => {},
  };
}

const stubFactory: MemoryProviderFactory = (id) =>
  makeStubProvider(id, `stub-${id}`);

describe('provider/registry', () => {
  afterEach(() => {
    clearRegistryForTests();
  });

  describe('registerFactory + getProvider', () => {
    it('未注册工厂时抛错', async () => {
      await expect(getProvider('user-a')).rejects.toThrow(
        /no factory registered/,
      );
    });

    it('注册后能拿到 provider 实例', async () => {
      registerFactory('builtin', stubFactory);
      const p = await getProvider('user-a');
      expect(p.id).toBe('__builtin__');
      const result = await p.search(
        // 最小读路径 ctx(无 sourceKind)
        { userId: 'user-a', projectId: null },
        { query: 'q' },
      );
      expect(result[0]?.memoryId).toBe('stub-__builtin__');
    });

    it('providerId 省略时回退到 DEFAULT_PROVIDER_ID', async () => {
      registerFactory('builtin', stubFactory);
      const explicit = await getProvider('user-a', '__builtin__');
      const implicit = await getProvider('user-a');
      // 同 key,第二次走缓存,是同一实例
      expect(explicit).toBe(implicit);
    });
  });

  describe('实例缓存', () => {
    it('同 (userId, providerId) 返回同一实例', async () => {
      registerFactory('builtin', stubFactory);
      const a = await getProvider('user-a');
      const b = await getProvider('user-a');
      expect(a).toBe(b);
      expect(registrySize()).toBe(1);
    });

    it('不同 userId 返回不同实例', async () => {
      registerFactory('builtin', stubFactory);
      const a = await getProvider('user-a');
      const b = await getProvider('user-b');
      expect(a).not.toBe(b);
      expect(registrySize()).toBe(2);
    });
  });

  describe('evictProvider', () => {
    it('驱逐指定 providerId 的缓存', async () => {
      registerFactory('builtin', stubFactory);
      const a1 = await getProvider('user-a');
      evictProvider('user-a');
      const a2 = await getProvider('user-a');
      expect(a1).not.toBe(a2);
    });

    it('驱逐某 userId 下全部实例(providerId 省略)', async () => {
      registerFactory('builtin', stubFactory);
      await getProvider('user-a');
      expect(registrySize()).toBe(1);
      evictProvider('user-a');
      expect(registrySize()).toBe(0);
    });
  });

  describe('并发 cache miss 去重', () => {
    it('并发同 key 只实例化一次(借鉴 memoh instantiate 持锁)', async () => {
      let constructCount = 0;
      const countingFactory: MemoryProviderFactory = (id) => {
        constructCount++;
        return makeStubProvider(id, `count-${id}`);
      };
      registerFactory('builtin', countingFactory);

      // 并发 5 个 getProvider,同 userId
      const results = await Promise.all([
        getProvider('user-a'),
        getProvider('user-a'),
        getProvider('user-a'),
        getProvider('user-a'),
        getProvider('user-a'),
      ]);

      expect(constructCount).toBe(1);
      for (const r of results) {
        expect(r).toBe(results[0]);
      }
    });
  });
});
