import { describe, expect, it } from 'vitest';

import type { InjectionStats, PackItem } from './context-packer';
import { packForContextInjection } from './context-packer';

function mkItem(
  text: string,
  opts: Partial<PackItem> & { source: PackItem['source'] },
): PackItem {
  return { text, score: 1, ...opts };
}

/** 取 stats,narrow 后返回(测试已断言 defined)。 */
function statsOf(r: { stats?: InjectionStats }): InjectionStats {
  if (!r.stats) throw new Error('stats undefined');
  return r.stats;
}

describe('packForContextInjection · Phase 4 预算优化模式', () => {
  describe('optimize=false(默认,严格等价)', () => {
    it('无 budget,optimize=false → 保留全部(不丢)', () => {
      const triggers = [mkItem('t1', { source: 'trigger' })];
      const recalls = Array.from({ length: 20 }, (_, i) =>
        mkItem(`r${i}`, { source: 'recall' }),
      );
      const result = packForContextInjection(triggers, recalls);
      expect(result.stats).toBeUndefined();
      expect(result.hasTriggerBlock).toBe(true);
      expect(result.hasRecallBlock).toBe(true);
    });

    it('给了 budget 但 optimize=false → budget 被忽略(等价)', () => {
      const recalls = Array.from({ length: 50 }, (_, i) =>
        mkItem(`r${i}`, { source: 'recall' }),
      );
      const result = packForContextInjection([], recalls, {
        optimize: false,
        budgetChars: 10,
      });
      expect(result.stats).toBeUndefined();
      expect(result.hasRecallBlock).toBe(true);
    });
  });

  describe('optimize=true(预算丢弃)', () => {
    it('optimize=true 无 budget → 不丢(无穷大预算)', () => {
      const recalls = Array.from({ length: 10 }, (_, i) =>
        mkItem(`r${i}`, { source: 'recall' }),
      );
      const result = packForContextInjection([], recalls, { optimize: true });
      const stats = statsOf(result);
      expect(stats.recallDropped).toBe(0);
      expect(stats.recallKept).toBe(10);
    });

    it('optimize=true 小 budget → recall 中段被丢', () => {
      const recalls = Array.from({ length: 6 }, (_, i) =>
        mkItem(`memory-item-${i}`, { source: 'recall' }),
      );
      const result = packForContextInjection([], recalls, {
        optimize: true,
        budgetChars: 80,
      });
      const stats = statsOf(result);
      expect(stats.recallKept).toBeLessThan(6);
      expect(stats.recallDropped).toBeGreaterThan(0);
      expect(result.text.length).toBeLessThanOrEqual(80);
    });

    it('recall 全丢光后,继续丢 trigger 末尾', () => {
      const triggers = Array.from({ length: 4 }, (_, i) =>
        mkItem(`trig-${i}`, { source: 'trigger' }),
      );
      const result = packForContextInjection(triggers, [], {
        optimize: true,
        budgetChars: 50,
      });
      const stats = statsOf(result);
      expect(stats.triggerDropped).toBeGreaterThan(0);
    });

    it('两 block 都有:优先丢 recall(recall 丢完前不动 trigger)', () => {
      const triggers = [mkItem('trigger-item', { source: 'trigger' })];
      const recalls = Array.from({ length: 8 }, (_, i) =>
        mkItem(`recall-item-${i}`, { source: 'recall' }),
      );
      // 给足预算让 trigger 必留(估算公式有冱差,给宽裕点)
      const triggerOnlyLen = packForContextInjection(triggers, [], {
        optimize: true,
      }).text.length;
      const budget = triggerOnlyLen + 200;
      const result = packForContextInjection(triggers, recalls, {
        optimize: true,
        budgetChars: budget,
      });
      const stats = statsOf(result);
      expect(stats.triggerKept).toBe(1);
      expect(stats.recallDropped).toBeGreaterThan(0);
    });

    it('reviewer phase4 B1:丢丰按 score 排序丢末尾(不丢中段)', () => {
      // 6 条降序 recall,score 1.0→Ø.5。丢几条后必颍是低分先丢
      const recalls = Array.from({ length: 6 }, (_, i) =>
        mkItem(`item-${i}`, {
          source: 'recall',
          score: 1 - i * 0.1, // 1.0, 0.9, 0.8, 0.7, 0.6, 0.5
          sourceKind: 'user_asserted',
        }),
      );
      // budget 设为 header + 2 条 → 只能留 2 条,必颍是高分前缀
      const result = packForContextInjection([], recalls, {
        optimize: true,
        budgetChars: 450, // header(~340) + 2条(~20)
      });
      const stats = statsOf(result);
      // 丢颍是末尾(低分项):保留集必颍是前缀(高分项)
      expect(result.text).toContain('item-0'); // score 1.0 必留
      expect(result.text).toContain('item-1'); // score 0.9 必留
      // 丢的必是末尾(item-4/5)
      if (stats.recallDropped > 0) {
        expect(result.text).not.toContain('item-5'); // 最低分必丢
      }
    });

    it('reviewer phase4 B1:taint 守安——trusted 比 unverified 优先保留', () => {
      // 1 条 trusted score 高 + 1 条 tool_observed score 低
      // budget 只能留 1 条 → 必须留 trusted
      const recalls = [
        mkItem('trusted-fact', {
          source: 'recall',
          score: 0.99,
          sourceKind: 'user_asserted',
        }),
        mkItem('tool-rumor', {
          source: 'recall',
          score: 0.3,
          sourceKind: 'tool_observed',
        }),
      ];
      const result = packForContextInjection([], recalls, {
        optimize: true,
        budgetChars: 500, // header(~340) + 1 条(~12)
      });
      // trusted-fact 必须保留(taint gate:trusted 优先于 unverified)
      expect(result.text).toContain('trusted-fact');
    });

    it('reviewer phase4 B2:recall 全 unverified 时跳过 recall block', () => {
      // trusted 被丢光,只剩 tool_observed → 不应产生矛盾的 recall block
      const recalls = [
        mkItem('trusted-1', {
          source: 'recall',
          score: 0.1, // 极低,容易被丢
          sourceKind: 'user_asserted',
        }),
        mkItem('tool-1', {
          source: 'recall',
          score: 0.9,
          sourceKind: 'tool_observed',
        }),
      ];
      // 极小 budget 强制丢 trusted-1 → 只剩 tool-1
      const result = packForContextInjection([], recalls, {
        optimize: true,
        budgetChars: 50,
      });
      // recall block 应被跳过(避免 header 说 authoritative 却只有 tool)
      expect(result.hasRecallBlock).toBe(false);
      expect(result.text).not.toContain('authoritative');
    });

    it('stats 含完整字段(可观测)', () => {
      const result = packForContextInjection(
        [mkItem('t', { source: 'trigger' })],
        [mkItem('r', { source: 'recall' })],
        { optimize: true, budgetChars: 1000 },
      );
      expect(result.stats).toEqual({
        triggerInputCount: 1,
        recallInputCount: 1,
        triggerKept: 1,
        recallKept: 1,
        triggerDropped: 0,
        recallDropped: 0,
        textLength: expect.any(Number),
        budgetChars: 1000,
      });
    });

    it('丢弃后仍保持 trusted/Unverified 分段语义', () => {
      const recalls = [
        mkItem('trusted-1', { source: 'recall', sourceKind: 'user_asserted' }),
        mkItem('tool-1', { source: 'recall', sourceKind: 'tool_observed' }),
      ];
      const result = packForContextInjection([], recalls, {
        optimize: true,
        budgetChars: 1000,
      });
      expect(result.text).toContain('Unverified');
      expect(result.text).toContain('tool-1');
    });
  });
});
