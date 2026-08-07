import { describe, expect, it } from 'vitest';

import { bumpMemoryVersion } from './write-gate';
import {
  buildCacheKey,
  pack,
  searchResultToPackItem,
  type PackItem,
} from './context-packer';

const ctx = {
  userId: 'user-a',
  projectId: null,
  sourceKind: 'user_asserted' as const,
};

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
  });

  describe('buildCacheKey(Phase 3 核心)', () => {
    it('包含 userId + queryHash + memoryVersion', () => {
      const key = buildCacheKey('user-a', 'hello', {});
      expect(key.userId).toBe('user-a');
      expect(typeof key.queryHash).toBe('number');
      expect(key.memoryVersion).toBe(0); // 初始
    });

    it('memoryVersion 写后变化 → cache key 失效', () => {
      const before = buildCacheKey('user-a', 'hello', {});
      bumpMemoryVersion(ctx.userId);
      const after = buildCacheKey('user-a', 'hello', {});
      expect(after.memoryVersion).toBe(before.memoryVersion + 1);
    });

    it('不同 query 的 hash 不同', () => {
      const k1 = buildCacheKey('user-a', 'hello', {});
      const k2 = buildCacheKey('user-a', 'world', {});
      expect(k1.queryHash).not.toBe(k2.queryHash);
    });

    it('不同预算/目标数 cache key 不同', () => {
      const k1 = buildCacheKey('user-a', 'q', {
        budgetChars: 1000,
        targetCount: 5,
      });
      const k2 = buildCacheKey('user-a', 'q', {
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
