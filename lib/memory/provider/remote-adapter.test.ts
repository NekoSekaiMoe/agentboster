import { describe, expect, it, vi } from 'vitest';

import type { KnowledgeProvider } from '@/lib/knowledge/providers';

import { adaptKnowledgeProvider } from './remote-adapter';

// ─── mock KnowledgeProvider(只实现 search)─────────────────────────

function makeMockKnowledgeProvider(
  searchImpl: (query: string) => Promise<unknown[]>,
): KnowledgeProvider {
  return {
    name: 'mem0',
    async search(input) {
      const results = await searchImpl(input.query);
      return results as never;
    },
  };
}

const readCtx = { userId: 'u', projectId: null };
const writeCtx = {
  userId: 'u',
  projectId: null,
  sourceKind: 'user_asserted' as const,
};

describe('RemoteMemoryProvider adapter', () => {
  describe('search 桥接', () => {
    it('把 KnowledgeProvider.search 结果映射成 SearchResult', async () => {
      const mock = makeMockKnowledgeProvider(async () => [
        {
          content: 'remote fact',
          title: 'remote-title',
          remoteId: 'r-1',
          score: 0.8,
          sourceUri: 'https://mem0/...',
        },
      ]);
      const provider = adaptKnowledgeProvider('mem0-1', {
        type: 'mem0',
        inner: mock,
        config: { endpoint: 'https://x' },
      });

      const results = await provider.search(readCtx, { query: 'q', topK: 3 });

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        key: '',
        content: 'remote fact',
        score: 0.8,
        sourceKind: 'tool_observed',
        // reviewer C1:memoryId 命名空间化用实例的真实 type/id(mem0:mem0-1:r-1)
        memoryId: 'mem0:mem0-1:r-1',
        retrievalMode: 'remote',
      });
    });

    it('sourceKind 恒为 tool_observed(taint gate:远程记忆进 Unverified 段)', async () => {
      // 即使远程返回 user_asserted 类的 metadata,adapter 仍强制 tool_observed
      const mock = makeMockKnowledgeProvider(async () => [
        { content: 'x', score: 0.9 },
      ]);
      const provider = adaptKnowledgeProvider('m', {
        type: 'mem0',
        inner: mock,
        config: {},
      });
      const [r] = await provider.search(readCtx, { query: 'q' });
      expect(r?.sourceKind).toBe('tool_observed');
    });

    it('remoteId 缺失时 memoryId 用 undefined(不填空串,避去重误判)', async () => {
      const mock = makeMockKnowledgeProvider(async () => [
        { content: 'no-id', score: 0.5 },
      ]);
      const provider = adaptKnowledgeProvider('m', {
        type: 'mem0',
        inner: mock,
        config: {},
      });
      const [r] = await provider.search(readCtx, { query: 'q' });
      expect(r?.memoryId).toBeUndefined();
    });

    it('score 缺失时给中性 0.5', async () => {
      const mock = makeMockKnowledgeProvider(async () => [
        { content: 'no-score' },
      ]);
      const provider = adaptKnowledgeProvider('m', {
        type: 'mem0',
        inner: mock,
        config: {},
      });
      const [r] = await provider.search(readCtx, { query: 'q' });
      expect(r?.score).toBe(0.5);
    });

    it('topK 省略时默认 5 传给 inner.search', async () => {
      const searchSpy = vi.fn(async (_input: unknown) => []);
      const mock: KnowledgeProvider = {
        name: 'mem0',
        async search(input) {
          return searchSpy(input);
        },
      };
      const provider = adaptKnowledgeProvider('m', {
        type: 'mem0',
        inner: mock,
        config: {},
      });
      await provider.search(readCtx, { query: 'q' });
      expect(searchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 5 }),
      );
    });

    it('reviewer phase5 B2:inner.search 抛错时 fail-open 返回空(与全链一致)', async () => {
      const mock = makeMockKnowledgeProvider(async () => {
        throw new Error('network down');
      });
      const provider = adaptKnowledgeProvider('m', {
        type: 'mem0',
        inner: mock,
        config: {},
      });
      // 不抛——返回空,避免远程挂了整盘 context 构建失败
      await expect(provider.search(readCtx, { query: 'q' })).resolves.toEqual(
        [],
      );
    });

    it('reviewer phase5 S4:enableRemote=false 时跳过远程(C2:不发起任何请求)', async () => {
      const searchSpy = vi.fn(async (_input: unknown) => [
        { content: 'x', score: 0.9 },
      ]);
      const mock: KnowledgeProvider = {
        name: 'mem0',
        async search(input) {
          return searchSpy(input);
        },
      };
      const provider = adaptKnowledgeProvider('m', {
        type: 'mem0',
        inner: mock,
        config: {},
      });
      const r = await provider.search(readCtx, {
        query: 'q',
        enableRemote: false,
      });
      // reviewer C2:guard 在 inner.search() 之前,禁远程时不应发起请求
      expect(searchSpy).not.toHaveBeenCalled();
      expect(r).toEqual([]);
    });

    it('reviewer phase5 S4:minConfidence 过滤低分结果', async () => {
      const mock = makeMockKnowledgeProvider(async () => [
        { content: 'high', score: 0.9 },
        { content: 'low', score: 0.1 },
      ]);
      const provider = adaptKnowledgeProvider('m', {
        type: 'mem0',
        inner: mock,
        config: {},
      });
      const r = await provider.search(readCtx, {
        query: 'q',
        minConfidence: 0.5,
      });
      expect(r).toHaveLength(1);
      expect(r[0]?.content).toBe('high');
    });
  });

  describe('写方法(只读 provider,全部 not-supported)', () => {
    const provider = adaptKnowledgeProvider('m', {
      type: 'mem0',
      inner: makeMockKnowledgeProvider(async () => []),
      config: {},
    });

    it('add 抛 not-supported', async () => {
      await expect(
        provider.add(writeCtx, { key: 'k', content: 'c' }),
      ).rejects.toThrow(/add not supported/);
    });

    it('update 抛 not-supported', async () => {
      await expect(
        provider.update(writeCtx, 'id', { content: 'c' }),
      ).rejects.toThrow(/update not supported/);
    });

    it('delete 抛 not-supported', async () => {
      await expect(provider.delete(writeCtx, ['id'])).rejects.toThrow(
        /delete not supported/,
      );
    });
  });

  describe('status', () => {
    it('返回 active(健康由调用方 try-search 确定)', async () => {
      const provider = adaptKnowledgeProvider('m', {
        type: 'mem0',
        inner: makeMockKnowledgeProvider(async () => []),
        config: {},
      });
      if (!provider.status) throw new Error('status not implemented');
      const s = await provider.status(readCtx);
      expect(s.mode).toBe('active');
      expect(s.detail).toContain('read-only');
    });
  });

  describe('类型契约', () => {
    it('满足 MemoryProvider 接口(编译期保证)', () => {
      const provider = adaptKnowledgeProvider('x', {
        type: 'http',
        inner: makeMockKnowledgeProvider(async () => []),
        config: {},
      });
      expect(provider.type).toBe('http');
      expect(provider.id).toBe('x');
      expect(typeof provider.search).toBe('function');
    });
  });
});
