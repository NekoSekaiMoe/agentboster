import { beforeEach, describe, expect, it, vi } from 'vitest';

// reviewer A3:mock KV 层 —— buildCacheKey 现读共享版本号。
const kvState = new Map<string, string>();
vi.mock('@/lib/core/kv', () => ({
  incr: vi.fn(async (key: string) => {
    const next = (Number.parseInt(kvState.get(key) ?? '0', 10) || 0) + 1;
    kvState.set(key, String(next));
    return next;
  }),
  get: vi.fn(async (key: string) => kvState.get(key) ?? null),
}));

import { bumpMemoryVersion } from './write-gate';
import {
  buildCacheKey,
  pack,
  searchResultToPackItem,
  type PackItem,
} from './context-packer';

describe('provider/context-packer', () => {
  describe('pack(等价模式 · Phase 0)', () => {
    it('空输入返回空文本', () => {
      const result = pack([]);
      expect(result.text).toBe('');
      expect(result.kept).toEqual([]);
      expect(result.dropped).toEqual([]);
    });

    it('按 score 降序贪婪装入', () => {
      const items: PackItem[] = [
        { text: 'low', score: 0.1, source: 'recall' },
        { text: 'high', score: 0.9, source: 'recall' },
        { text: 'mid', score: 0.5, source: 'trigger' },
      ];
      const result = pack(items);
      expect(result.kept.map((i) => i.text)).toEqual(['high', 'mid', 'low']);
    });

    it('importance 加权(score*importance)', () => {
      const items: PackItem[] = [
        {
          text: 'high-score-low-importance',
          score: 0.9,
          importance: 1,
          source: 'recall',
        },
        {
          text: 'low-score-high-importance',
          score: 0.1,
          importance: 10,
          source: 'recall',
        },
      ];
      const result = pack(items);
      // 0.1*10=1.0 > 0.9*1=0.9
      expect(result.kept[0]?.text).toBe('low-score-high-importance');
    });

    it('字符预算超限时丢弃后续(不替换已选)', () => {
      const items: PackItem[] = [
        { text: 'a'.repeat(100), score: 0.9, source: 'recall' },
        { text: 'b'.repeat(100), score: 0.8, source: 'recall' },
        { text: 'c'.repeat(2000), score: 0.7, source: 'recall' }, // 单条就超预算
      ];
      const result = pack(items, { budgetChars: 200 });
      // 前两条占 200,第三条进 dropped
      expect(result.kept.length).toBe(2);
      expect(result.dropped.length).toBe(1);
      expect(result.stats.budgetUsed).toBe(200);
    });

    it('targetCount 限制条数', () => {
      const items: PackItem[] = Array.from({ length: 10 }, (_, i) => ({
        text: `item-${i}`,
        score: 1 - i * 0.1,
        source: 'recall' as const,
      }));
      const result = pack(items, { targetCount: 3 });
      expect(result.kept.length).toBe(3);
      expect(result.dropped.length).toBe(7);
    });

    it('reviewer D11:首条记录即超预算时仍保留(kept.length > 0 边界)', () => {
      // 关键边界:即使最高分条目单独就超预算,也应作为首条保留,
      // 而不是返回空 kept(避免"一条都没进"的退化)。
      const items: PackItem[] = [
        { text: 'x'.repeat(5000), score: 0.9, source: 'recall' },
      ];
      const result = pack(items, { budgetChars: 200 });
      expect(result.kept.length).toBe(1);
      expect(result.kept[0]?.text).toBe('x'.repeat(5000));
      expect(result.dropped.length).toBe(0);
      expect(result.stats.budgetUsed).toBe(5000);
    });
  });

  describe('buildCacheKey(Phase 3 核心)', () => {
    beforeEach(() => {
      kvState.clear();
    });

    it('包含 userId + queryHash + memoryVersion', async () => {
      // reviewer D11:每个用例用独立 userId,避免 bumpMemoryVersion 造成顺序依赖
      const key = await buildCacheKey('user-init', 'hello', {});
      expect(key.userId).toBe('user-init');
      expect(typeof key.queryHash).toBe('number');
      expect(key.memoryVersion).toBe(0); // 初始
    });

    it('memoryVersion 写后变化 → cache key 失效', async () => {
      // reviewer D11:用独立 userId,不与其他用例共享 version 计数器
      const before = await buildCacheKey('user-bump', 'hello', {});
      await bumpMemoryVersion('user-bump');
      const after = await buildCacheKey('user-bump', 'hello', {});
      expect(after.memoryVersion).toBe(before.memoryVersion + 1);
    });

    it('不同 query 的 hash 不同', async () => {
      const k1 = await buildCacheKey('user-query', 'hello', {});
      const k2 = await buildCacheKey('user-query', 'world', {});
      expect(k1.queryHash).not.toBe(k2.queryHash);
    });

    it('不同预算/目标数 cache key 不同', async () => {
      const k1 = await buildCacheKey('user-opts', 'q', {
        budgetChars: 1000,
        targetCount: 5,
      });
      const k2 = await buildCacheKey('user-opts', 'q', {
        budgetChars: 2000,
        targetCount: 6,
      });
      expect(k1.budgetChars).not.toBe(k2.budgetChars);
      expect(k1.targetCount).not.toBe(k2.targetCount);
    });
  });

  describe('searchResultToPackItem', () => {
    it('SearchResult → PackItem 透传字段', () => {
      const item = searchResultToPackItem(
        {
          memoryId: 'm1',
          key: 'k1',
          content: 'hello',
          score: 0.8,
          importance: 2,
          sourceKind: 'user_asserted',
        },
        'recall',
      );
      expect(item).toEqual({
        text: 'hello',
        score: 0.8,
        importance: 2,
        sourceKind: 'user_asserted',
        source: 'recall',
        memoryId: 'm1',
      });
    });
  });
});
