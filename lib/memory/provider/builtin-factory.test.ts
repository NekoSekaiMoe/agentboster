import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// mock 底层 lib/memory(避免真连 DB)
const upsertMock = vi.fn();
vi.mock('@/lib/memory', () => ({
  recallRelevantMemories: vi.fn(async () => []),
  upsertLongTermMemory: (...args: unknown[]) => upsertMock(...args),
  updateLongTermMemory: vi.fn(async () => ({ memory: {}, indexing: {} })),
  deleteLongTermMemory: vi.fn(async () => true),
  // reviewer D6:builtin.ts 静态 import getLongTermMemory 并在 update 里调,缺导出会 undefined 调用报错。
  getLongTermMemory: vi.fn(async () => null),
}));

// reviewer A3:mock KV —— version 号现落共享存储,测试不连真 KV。
const kvState = new Map<string, string>();
vi.mock('@/lib/core/kv', () => ({
  incr: vi.fn(async (key: string) => {
    const next = (Number.parseInt(kvState.get(key) ?? '0', 10) || 0) + 1;
    kvState.set(key, String(next));
    return next;
  }),
  get: vi.fn(async (key: string) => kvState.get(key) ?? null),
}));

import {
  _resetBuiltinFactoryRegistrationForTests,
  registerBuiltinFactory,
} from './builtin-factory';
import { clearRegistryForTests, getProvider } from './registry';
import { clearWriteGateForTests, readMemoryVersion } from './write-gate';

describe('builtin-factory + registry 集成', () => {
  beforeEach(() => {
    _resetBuiltinFactoryRegistrationForTests();
    clearRegistryForTests();
    clearWriteGateForTests();
    kvState.clear();
    upsertMock.mockReset();
    upsertMock.mockResolvedValue({
      memory: { id: 'row-1' },
      indexing: {},
      created: true,
    });
  });
  afterEach(() => {
    _resetBuiltinFactoryRegistrationForTests();
    clearRegistryForTests();
    clearWriteGateForTests();
  });

  it('registerBuiltinFactory 后 getProvider 拿到的是封箱 provider(Phase 3:封箱转发到底层)', async () => {
    registerBuiltinFactory();

    const provider = await getProvider('user-a');
    expect(provider.id).toBe('__builtin__');
    expect(provider.type).toBe('builtin');

    // 读不 bump
    expect(await readMemoryVersion('user-a')).toBe(0);
    await provider.search(
      { userId: 'user-a', projectId: null },
      { query: 'q' },
    );
    expect(await readMemoryVersion('user-a')).toBe(0);

    // 写:final-review B2 后,封箱的 commitMemoryWrite 会 bump(provider 路径)
    await provider.add(
      { userId: 'user-a', projectId: null, sourceKind: 'user_asserted' },
      { key: 'k', content: 'c' },
    );
    expect(upsertMock).toHaveBeenCalledTimes(1); // 证明转发到底层
    expect(await readMemoryVersion('user-a')).toBe(1); // commitMemoryWrite bump
  });

  it('registerBuiltinFactory 幂等(重复注册不覆盖)', () => {
    expect(() => {
      registerBuiltinFactory();
      registerBuiltinFactory();
    }).not.toThrow();
  });

  it('同 userId 第二次 getProvider 走缓存(同一实例)', async () => {
    registerBuiltinFactory();
    const a = await getProvider('user-a');
    const b = await getProvider('user-a');
    expect(a).toBe(b);
  });
});
