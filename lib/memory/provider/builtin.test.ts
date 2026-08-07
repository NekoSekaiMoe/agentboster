import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── mock 现有 lib/memory(BuiltinProvider 桥接的目标)─────────────
// 不真连 DB,只验证 provider 把参数正确转发到底层函数 + 返回值正确映射。

const recallMock = vi.fn();
const upsertMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const getMemoryMock = vi.fn();

vi.mock('@/lib/memory', () => ({
  recallRelevantMemories: (...args: unknown[]) => recallMock(...args),
  upsertLongTermMemory: (...args: unknown[]) => upsertMock(...args),
  updateLongTermMemory: (...args: unknown[]) => updateMock(...args),
  deleteLongTermMemory: (...args: unknown[]) => deleteMock(...args),
  getLongTermMemory: (...args: unknown[]) => getMemoryMock(...args),
}));

// reviewer A5:status 现在走运行时 getConfig() 兑底;mock 成 null 使
// 「无注入 config」路径的测试确定性(避免依赖测试环境的 KV 状态)。
const getConfigMock = vi.fn();
vi.mock('@/lib/core/kv/config', () => ({
  getConfig: (...args: unknown[]) => getConfigMock(...args),
}));

// ─── 在 import BuiltinProvider 之前,mock write-gate 的 readMemoryVersion ──
// 这桂测试不依赖 write-gate 的真实进程状态(readMemoryVersion 被 mock)
vi.mock('./write-gate', async () => {
  const actual =
    await vi.importActual<typeof import('./write-gate')>('./write-gate');
  return {
    ...actual,
    // reviewer A3:readMemoryVersion 现是 async(KV 读);mock 成同步返 42 仍兼容 await。
    readMemoryVersion: vi.fn(async () => 42),
  };
});

import { _createBuiltinProviderInternal as createBuiltinProvider } from './builtin';

describe('BuiltinProvider', () => {
  beforeEach(() => {
    recallMock.mockReset();
    upsertMock.mockReset();
    updateMock.mockReset();
    deleteMock.mockReset();
    getMemoryMock.mockReset();
    getConfigMock.mockReset();
    getConfigMock.mockResolvedValue(null);
  });

  describe('search(读路径,用 ReadContext)', () => {
    it('桥接到 recallRelevantMemories,透传 userId/query/topK/minConfidence', async () => {
      recallMock.mockResolvedValue([
        {
          content: 'hello',
          score: 0.9,
          memoryId: 'm1',
          sourceKind: 'user_asserted',
        },
      ]);

      const provider = createBuiltinProvider('__builtin__');
      const results = await provider.search(
        { userId: 'user-a', projectId: null }, // 无 sourceKind(读路径)
        { query: 'q', topK: 8, minConfidence: 0.1 },
      );

      expect(recallMock).toHaveBeenCalledWith({
        userId: 'user-a',
        query: 'q',
        topK: 8,
        minConfidence: 0.1,
        config: undefined,
      });
      expect(results).toEqual([
        {
          memoryId: 'm1',
          key: '',
          content: 'hello',
          score: 0.9,
          sourceKind: 'user_asserted',
        },
      ]);
    });

    it('topK/minConfidence 省略时用默认值', async () => {
      recallMock.mockResolvedValue([]);
      const provider = createBuiltinProvider('__builtin__');
      await provider.search({ userId: 'u', projectId: null }, { query: 'q' });

      expect(recallMock).toHaveBeenCalledWith(
        expect.objectContaining({ topK: 5, minConfidence: 0.02 }),
      );
    });

    it('RecalledMemory 无 memoryId 时填空串(映射兼容)', async () => {
      recallMock.mockResolvedValue([{ content: 'c', score: 0.5 }]);
      const provider = createBuiltinProvider('__builtin__');
      const [r] = await provider.search(
        { userId: 'u', projectId: null },
        { query: 'q' },
      );
      // reviewer #6:memoryId 缺失不填空串(会误判去重),用 undefined
      expect(r?.memoryId).toBeUndefined();
    });
  });

  describe('add(写路径,sourceKind 透传)', () => {
    it('ctx.sourceKind → upsertLongTermMemory.sourceKind', async () => {
      upsertMock.mockResolvedValue({
        memory: { id: 'row-1' },
        indexing: {},
        created: true,
      });

      const provider = createBuiltinProvider('__builtin__');
      const ref = await provider.add(
        { userId: 'user-a', projectId: null, sourceKind: 'tool_observed' },
        { key: 'k', content: 'c' },
      );

      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-a',
          key: 'k',
          content: 'c',
          sourceKind: 'tool_observed',
        }),
      );
      expect(ref).toEqual({ id: 'row-1', key: 'k' });
    });

    it('sourceKindOverride 覆盖 ctx.sourceKind(taint gate 显式降级)', async () => {
      // 场景:extractor 把 assistant_observed 降级为 tool_observed
      upsertMock.mockResolvedValue({
        memory: { id: 'x' },
        indexing: {},
        created: true,
      });

      const provider = createBuiltinProvider('__builtin__');
      await provider.add(
        { userId: 'u', projectId: null, sourceKind: 'assistant_observed' },
        {
          key: 'k',
          content: 'c',
          sourceKindOverride: 'tool_observed',
        },
      );

      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({ sourceKind: 'tool_observed' }),
      );
    });

    it('memoryType / triggerPhrases / importance 透传(reviewer #1 字段)', async () => {
      upsertMock.mockResolvedValue({
        memory: { id: 'x' },
        indexing: {},
        created: true,
      });

      const provider = createBuiltinProvider('__builtin__');
      await provider.add(
        { userId: 'u', projectId: null, sourceKind: 'user_asserted' },
        {
          key: 'k',
          content: 'c',
          memoryType: 'preference',
          importance: 7,
          triggerPhrases: ['likes coffee'],
        },
      );

      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          memoryType: 'preference',
          importance: 7,
          triggerPhrases: ['likes coffee'],
        }),
      );
    });

    it('projectId 省略时取 ctx.projectId', async () => {
      upsertMock.mockResolvedValue({
        memory: { id: 'x' },
        indexing: {},
        created: true,
      });
      const provider = createBuiltinProvider('__builtin__');
      await provider.add(
        { userId: 'u', projectId: 'proj-1', sourceKind: 'user_asserted' },
        { key: 'k', content: 'c' },
      );
      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'proj-1' }),
      );
    });

    it('reviewer #2:dreamStatus/dreamMeta 全字段透传(不再静默丢)', async () => {
      // Dream tentative 提案必须落库为 tentative,否则会被 recall 当 active 注入
      upsertMock.mockResolvedValue({
        memory: { id: 'x' },
        indexing: {},
        created: true,
      });
      const provider = createBuiltinProvider('__builtin__');
      await provider.add(
        { userId: 'u', projectId: null, sourceKind: 'dream_consolidated' },
        {
          key: 'dream.proposal.x',
          content: 'maybe a fact',
          dreamStatus: 'tentative',
          dreamMeta: { confidence: 0.3, source: 'phase2-recombine' },
        },
      );
      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          dreamStatus: 'tentative',
          dreamMeta: { confidence: 0.3, source: 'phase2-recombine' },
        }),
      );
    });

    it('reviewer #7:taint 不可逆:user_asserted 不被隐式降级', async () => {
      // 关键安全语义:信任只能降不能升。user_asserted 必须原样透传。
      upsertMock.mockResolvedValue({
        memory: { id: 'x' },
        indexing: {},
        created: true,
      });
      const provider = createBuiltinProvider('__builtin__');
      await provider.add(
        { userId: 'u', projectId: null, sourceKind: 'user_asserted' },
        { key: 'k', content: 'I like coffee' },
      );
      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({ sourceKind: 'user_asserted' }),
      );
    });
  });

  describe('update', () => {
    it('有 content 且 owner 匹配时桥接到 updateLongTermMemory', async () => {
      getMemoryMock.mockResolvedValue({ userId: 'u', id: 'id-1' });
      updateMock.mockResolvedValue({ memory: {}, indexing: {} });
      const provider = createBuiltinProvider('__builtin__');
      await provider.update(
        { userId: 'u', projectId: null, sourceKind: 'user_asserted' },
        'id-1',
        { content: 'new' },
      );
      expect(updateMock).toHaveBeenCalledWith({
        id: 'id-1',
        content: 'new',
        config: undefined,
      });
    });

    it('patch 无 content 时 no-op(不调 updateLongTermMemory)', async () => {
      const provider = createBuiltinProvider('__builtin__');
      await provider.update(
        { userId: 'u', projectId: null, sourceKind: 'user_asserted' },
        'id-1',
        {}, // reviewer A2:无 content 时幂等 no-op(其余字段已从 MemoryPatch 主契约移出)
      );
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('reviewer #5:owner 不匹配时拒绝更新(跨用户隔离)', async () => {
      getMemoryMock.mockResolvedValue({ userId: 'other-user', id: 'id-1' });
      const provider = createBuiltinProvider('__builtin__');
      await provider.update(
        { userId: 'u', projectId: null, sourceKind: 'user_asserted' },
        'id-1',
        { content: 'new' },
      );
      expect(updateMock).not.toHaveBeenCalled(); // 拒绝
    });

    it('行不存在时 no-op', async () => {
      getMemoryMock.mockResolvedValue(null);
      const provider = createBuiltinProvider('__builtin__');
      await provider.update(
        { userId: 'u', projectId: null, sourceKind: 'user_asserted' },
        'id-1',
        { content: 'new' },
      );
      expect(updateMock).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('批量逐个调 deleteLongTermMemory,透传 userId', async () => {
      deleteMock.mockResolvedValue(true);
      const provider = createBuiltinProvider('__builtin__');
      await provider.delete(
        { userId: 'user-a', projectId: null, sourceKind: 'user_asserted' },
        ['id-1', 'id-2'],
      );
      expect(deleteMock).toHaveBeenCalledTimes(2);
      expect(deleteMock).toHaveBeenCalledWith('id-1', { userId: 'user-a' });
      expect(deleteMock).toHaveBeenCalledWith('id-2', { userId: 'user-a' });
    });
  });

  describe('status(phase1-review #9:embedding_model 检测)', () => {
    it('无 config 时返 degraded(无 embedding_model)', async () => {
      const provider = createBuiltinProvider('__builtin__');
      if (!provider.status) throw new Error('status not implemented');
      const s = await provider.status({ userId: 'u', projectId: null });
      expect(s.mode).toBe('degraded');
    });

    it('配置了 embedding_model 时返 active', async () => {
      const provider = createBuiltinProvider('__builtin__', {
        config: {
          models: { embedding_model: 'text-embedding-3-small' },
        } as never,
      });
      if (!provider.status) throw new Error('status not implemented');
      const s = await provider.status({ userId: 'u', projectId: null });
      expect(s.mode).toBe('active');
    });
  });

  describe('memoryVersion(MemoryVersionCapability)', () => {
    it('透传 write-gate 的 readMemoryVersion(mock 为 42)', async () => {
      const provider = createBuiltinProvider('__builtin__');
      const v = await provider.memoryVersion({ userId: 'u', projectId: null });
      expect(v).toBe(42);
    });
  });

  describe('类型契约', () => {
    it('createBuiltinProvider 返回值满足 BuiltinProvider 类型(编译期保证)', () => {
      const provider = createBuiltinProvider('x');
      // 静态属性
      expect(provider.type).toBe('builtin');
      expect(provider.id).toBe('x');
      // 主接口方法都在
      expect(typeof provider.search).toBe('function');
      expect(typeof provider.add).toBe('function');
      expect(typeof provider.update).toBe('function');
      expect(typeof provider.delete).toBe('function');
      // MemoryVersionCapability 方法在
      expect(typeof provider.memoryVersion).toBe('function');
    });
  });
});
