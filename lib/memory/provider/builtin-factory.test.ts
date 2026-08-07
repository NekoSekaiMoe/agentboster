import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// mock 底层 lib/memory(避免真连 DB)
const upsertMock = vi.fn();
vi.mock('@/lib/memory', () => ({
  recallRelevantMemories: vi.fn(async () => []),
  upsertLongTermMemory: (...args: unknown[]) => upsertMock(...args),
  updateLongTermMemory: vi.fn(async () => ({ memory: {}, indexing: {} })),
  deleteLongTermMemory: vi.fn(async () => true),
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
    expect(readMemoryVersion('user-a')).toBe(0);
    await provider.search(
      { userId: 'user-a', projectId: null },
      { query: 'q' },
    );
    expect(readMemoryVersion('user-a')).toBe(0);

    // 写:final-review B2 后,封箱的 commitMemoryWrite 会 bump(provider 路径)
    await provider.add(
      { userId: 'user-a', projectId: null, sourceKind: 'user_asserted' },
      { key: 'k', content: 'c' },
    );
    expect(upsertMock).toHaveBeenCalledTimes(1); // 证明转发到底层
    expect(readMemoryVersion('user-a')).toBe(1); // commitMemoryWrite bump
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
