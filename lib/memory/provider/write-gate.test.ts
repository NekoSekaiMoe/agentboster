import { afterEach, describe, expect, it } from 'vitest';

import type { MemoryProvider } from './types';
import {
  bumpMemoryVersion,
  clearWriteGateForTests,
  commitMemoryWrite,
  onMemoryVersionChange,
  readMemoryVersion,
  wrapWithWriteGate,
} from './write-gate';

// ─── 测试用裸 provider(记录每次写)──────────────────────────────

function makeRecordingProvider(): MemoryProvider & { writes: number } {
  let writes = 0;
  const provider: MemoryProvider = {
    type: 'builtin',
    id: 'rec',
    search: async () => [],
    add: async () => {
      writes++;
      return { id: `id-${writes}`, key: 'k' };
    },
    update: async () => {
      writes++;
    },
    delete: async () => {
      writes++;
    },
  };
  return Object.assign(provider, {
    get writes() {
      return writes;
    },
  });
}

const ctx = {
  userId: 'user-a',
  projectId: null,
  sourceKind: 'user_asserted' as const,
};

describe('provider/write-gate (Phase 3 语义)', () => {
  afterEach(() => {
    clearWriteGateForTests();
  });

  describe('版本计数器', () => {
    it('初始版本为 0', () => {
      expect(readMemoryVersion('user-a')).toBe(0);
    });

    it('bumpMemoryVersion 自增(Phase 3:唯一公开的自增 API)', () => {
      bumpMemoryVersion('user-a');
      expect(readMemoryVersion('user-a')).toBe(1);
      bumpMemoryVersion('user-a');
      expect(readMemoryVersion('user-a')).toBe(2);
    });

    it('版本按 userId 隔离', () => {
      bumpMemoryVersion('user-a');
      expect(readMemoryVersion('user-a')).toBe(1);
      expect(readMemoryVersion('user-b')).toBe(0);
    });

    it('final-review B2:commitMemoryWrite 直接 bump(provider 路径)', async () => {
      // provider 路径经 write-gate,op 是空也 bump(与 invalidateMemoryCaches 互斥)
      await commitMemoryWrite(ctx, async () => {});
      expect(readMemoryVersion('user-a')).toBe(1);
    });
  });

  describe('wrapWithWriteGate', () => {
    it('Phase 3:write-gate bump,op 内部不需再 bump(避免 double)', async () => {
      const inner = makeRecordingProvider();
      const committed = wrapWithWriteGate(inner);

      expect(readMemoryVersion('user-a')).toBe(0);
      // inner.add 不调任何 bump,但 commitMemoryWrite 会 bump
      await committed.add(ctx, { key: 'k', content: 'c' });
      expect(readMemoryVersion('user-a')).toBe(1);
    });

    it('读方法(search)不 bump version', async () => {
      const inner = makeRecordingProvider();
      const committed = wrapWithWriteGate(inner);

      await committed.search(ctx, { query: 'q' });
      await committed.search(ctx, { query: 'q' });
      expect(readMemoryVersion('user-a')).toBe(0);
    });

    it('封箱后仍保留原 provider 的 id/type(Proxy 透传)', async () => {
      const inner = makeRecordingProvider();
      const committed = wrapWithWriteGate(inner);
      expect(committed.id).toBe('rec');
      expect(committed.type).toBe('builtin');
    });

    it('op 抛错时 version 不自增(原子性)', async () => {
      // 关键:避免"写失败但 version bump 了"导致 cache 误失效或反之
      const inner = makeRecordingProvider();

      const failingProvider: MemoryProvider = {
        ...inner,
        add: async () => {
          throw new Error('write failed');
        },
      };
      const failing = wrapWithWriteGate(failingProvider);

      await expect(
        failing.add(ctx, { key: 'k', content: 'c' }),
      ).rejects.toThrow('write failed');
      expect(readMemoryVersion('user-a')).toBe(0);
    });

    it('phase0-review #5:解构 { add } 调用仍正确(this 绑定 + bump)', async () => {
      // 关键:wrapWithWriteGate 的 committedAdd 是箭头闭包,内部 inner.add(...)
      // 是显式方法调用,this 绑定 inner。即使调用方解构出 add,闭包捕获不变。
      const inner = makeRecordingProvider();
      const committed = wrapWithWriteGate(inner);
      const { add } = committed;
      await add(ctx, { key: 'k', content: 'c' });
      // commitMemoryWrite bump 证明 add 被调且未抛 TypeError(this 绑定正确)
      expect(readMemoryVersion('user-a')).toBe(1);
    });
  });

  describe('onMemoryVersionChange', () => {
    it('版本变化时通知订阅者', () => {
      const events: Array<{ user: string; version: number }> = [];
      onMemoryVersionChange((user, version) => {
        events.push({ user, version });
      });

      bumpMemoryVersion('user-a');
      bumpMemoryVersion('user-a');

      expect(events).toEqual([
        { user: 'user-a', version: 1 },
        { user: 'user-a', version: 2 },
      ]);
    });

    it('订阅者故障不影响 bump(fire-and-forget)', () => {
      onMemoryVersionChange(() => {
        throw new Error('listener exploded');
      });
      expect(() => bumpMemoryVersion('user-a')).not.toThrow();
      expect(readMemoryVersion('user-a')).toBe(1);
    });
  });
});
