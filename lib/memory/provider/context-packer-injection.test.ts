import { describe, expect, it } from 'vitest';

import { formatRecalledMemoriesForContext } from '@/lib/memory/recall';
import {
  formatTriggeredMemoriesForContext,
  type TriggeredMemory,
} from '@/lib/memory/triggers';
import type { RecalledMemory } from '@/lib/memory/recall';

import { packForContextInjection, type PackItem } from './context-packer';

// ─── helper:RecalledMemory → PackItem(recall source)───────────────
function recalledToItem(m: RecalledMemory): PackItem {
  return {
    text: m.content,
    score: m.score,
    sourceKind: m.sourceKind,
    source: 'recall',
    memoryId: m.memoryId,
  };
}

// ─── helper:triggered memories(用真实 TriggeredMemory 类型,phase2-review #4)──
// 不用 as never 绕过类型 —— 让 oracle 真正约束输入结构兼容。
function triggeredToItem(m: TriggeredMemory): PackItem {
  return {
    text: m.content,
    score: m.score,
    importance: m.importance,
    sourceKind: m.sourceKind,
    source: 'trigger',
    memoryId: m.memoryId,
  };
}

/** 构造完整 TriggeredMemory(缺省字段补默认值),避免 as never。 */
function mkTriggered(
  partial: Partial<TriggeredMemory> & { content: string },
): TriggeredMemory {
  return {
    memoryId: 'm-default',
    importance: 5,
    matchedPhrase: 'default-phrase',
    score: 1,
    sourceKind: 'user_asserted',
    ...partial,
  } as TriggeredMemory;
}

describe('packForContextInjection · 等价于现有 format 函数组合', () => {
  describe('空输入', () => {
    it('两边都空 → 空文本,无 block', () => {
      const result = packForContextInjection([], []);
      expect(result.text).toBe('');
      expect(result.hasTriggerBlock).toBe(false);
      expect(result.hasRecallBlock).toBe(false);
    });
  });

  describe('只有 recall(对齐 formatRecalledMemoriesForContext)', () => {
    it('单条 trusted', () => {
      const recalled: RecalledMemory[] = [
        { content: 'likes coffee', score: 0.9, sourceKind: 'user_asserted' },
      ];
      const existing = formatRecalledMemoriesForContext(recalled);
      const result = packForContextInjection([], recalled.map(recalledToItem));
      expect(result.hasRecallBlock).toBe(true);
      expect(result.hasTriggerBlock).toBe(false);
      // recall block 应严格等于现有函数输出
      expect(result.text).toBe(existing);
    });

    it('多条含 tool_observed(分 Unverified 段)', () => {
      const recalled: RecalledMemory[] = [
        { content: 'trusted-1', score: 0.9, sourceKind: 'user_asserted' },
        { content: 'tool-1', score: 0.7, sourceKind: 'tool_observed' },
        { content: 'trusted-2', score: 0.8, sourceKind: 'assistant_observed' },
      ];
      const existing = formatRecalledMemoriesForContext(recalled);
      const result = packForContextInjection([], recalled.map(recalledToItem));
      expect(result.text).toBe(existing);
    });

    it('全 tool_observed(只 Unverified 段)', () => {
      const recalled: RecalledMemory[] = [
        { content: 'tool-a', score: 0.5, sourceKind: 'tool_observed' },
        { content: 'tool-b', score: 0.4, sourceKind: 'tool_observed' },
      ];
      const existing = formatRecalledMemoriesForContext(recalled);
      const result = packForContextInjection([], recalled.map(recalledToItem));
      expect(result.text).toBe(existing);
    });

    it('多条触发 anti-lost-in-middle 重排(4 条)', () => {
      const recalled: RecalledMemory[] = Array.from({ length: 4 }, (_, i) => ({
        content: `m${i}`,
        score: 1 - i * 0.1,
        sourceKind: 'user_asserted' as const,
      }));
      const existing = formatRecalledMemoriesForContext(recalled);
      const result = packForContextInjection([], recalled.map(recalledToItem));
      expect(result.text).toBe(existing);
    });
  });

  describe('只有 trigger(对齐 formatTriggeredMemoriesForContext)', () => {
    it('单条 trusted', () => {
      const triggered: TriggeredMemory[] = [
        mkTriggered({ content: 't1', sourceKind: 'user_asserted' }),
      ];
      // 用现有函数做 oracle(它接受 TriggeredMemory[],我们用结构兼容的输入)
      const existing = formatTriggeredMemoriesForContext(triggered);
      const result = packForContextInjection(
        triggered.map(triggeredToItem),
        [],
      );
      expect(result.hasTriggerBlock).toBe(true);
      expect(result.hasRecallBlock).toBe(false);
      expect(result.text).toBe(existing);
    });

    it('多条含 tool_observed', () => {
      const triggered: TriggeredMemory[] = [
        mkTriggered({ content: 't1', sourceKind: 'user_asserted' }),
        mkTriggered({ content: 't-tool', sourceKind: 'tool_observed' }),
      ];
      const existing = formatTriggeredMemoriesForContext(triggered);
      const result = packForContextInjection(
        triggered.map(triggeredToItem),
        [],
      );
      expect(result.text).toBe(existing);
    });
  });

  describe('两 block 共存(对齐 context/index.ts 270-282 的拼接顺序)', () => {
    it('trigger 在前,recall 在后,中间空行分隔', () => {
      const triggered: TriggeredMemory[] = [
        mkTriggered({ content: 'trig-1', sourceKind: 'user_asserted' }),
      ];
      const recalled: RecalledMemory[] = [
        { content: 'rec-1', score: 0.8, sourceKind: 'user_asserted' },
      ];
      const tExisting = formatTriggeredMemoriesForContext(triggered);
      const rExisting = formatRecalledMemoriesForContext(recalled);

      const result = packForContextInjection(
        triggered.map(triggeredToItem),
        recalled.map(recalledToItem),
      );
      expect(result.hasTriggerBlock).toBe(true);
      expect(result.hasRecallBlock).toBe(true);
      expect(result.text).toBe(`${tExisting}\n\n${rExisting}`);
    });
  });

  describe('编号连续性(taint gate 关键)', () => {
    it('recall block:trusted 段编号 1..N,Unverified 段接着编号', () => {
      const recalled: RecalledMemory[] = [
        { content: 't1', score: 0.9, sourceKind: 'user_asserted' },
        { content: 't2', score: 0.8, sourceKind: 'user_asserted' },
        { content: 'u1', score: 0.5, sourceKind: 'tool_observed' },
      ];
      const result = packForContextInjection([], recalled.map(recalledToItem));
      // t1=1, t2=2, u1=3(连续编号,与现有一致)
      expect(result.text).toContain('1. t1');
      expect(result.text).toContain('2. t2');
      expect(result.text).toContain('3. u1');
    });

    it('trigger 和 recall 各自从 1 开始编号(独立 block)', () => {
      const triggered: TriggeredMemory[] = [
        mkTriggered({ content: 'trig-a', sourceKind: 'user_asserted' }),
      ];
      const recalled: RecalledMemory[] = [
        { content: 'rec-a', score: 0.8, sourceKind: 'user_asserted' },
      ];
      const result = packForContextInjection(
        triggered.map(triggeredToItem),
        recalled.map(recalledToItem),
      );
      // 两个 block 都有 "1.",各自独立编号
      expect(result.text.match(/^1\. /gm)?.length).toBe(2);
    });
  });
});
