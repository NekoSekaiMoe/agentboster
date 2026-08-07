/**
 * Phase 3 失效链守卫:确保所有 memory 写路径都触发 version bump。
 *
 * phase1-review #1 的核心问题:Dream/extract 绕过 write-gate 导致漏 bump。
 * Phase 3 的修复:bump 挂在失效层(invalidateMemoryCaches + long-term.ts
 * 内部的 bumpMemoryVersion 调用),覆盖所有写路径。
 *
 * reviewer phase3 B1/B2/B3:静态守卫必须覆盖裸 DAL 透传路径,不只看包装函数。
 * 本测试用静态扫描验证调用点存在(运行时验证需 DB 集成测试)。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readFile(rel: string): string {
  return readFileSync(`${process.cwd()}/${rel}`, 'utf8');
}

describe('Phase 3 失效链:bumpMemoryVersion 调用点', () => {
  it('cache-invalidation.ts 的 invalidateMemoryCaches 调用 bumpMemoryVersion', () => {
    const text = readFile('lib/memory/cache-invalidation.ts');
    expect(text).toContain('bumpMemoryVersion(userId)');
    expect(text).toContain('bumpMemoryVersion');
    expect(text).toContain("from '@/lib/memory/provider/write-gate'");
  });

  it('long-term.ts 的 4 个写函数不再直接 bump(final-review B2:bump 责任移交)', () => {
    const text = readFile('lib/memory/long-term.ts');
    // B2 修复后:long-term.ts 不应再直接调 bumpMemoryVersion。
    // bump 责任统一到 invalidateMemoryCaches(非 provider 路径)+
    // commitMemoryWrite(provider 路径)。
    expect(text).not.toContain('bumpMemoryVersion');
    expect(text).not.toContain("from './provider/write-gate'");
  });

  it('dream/apply.ts 在 apply 完成后调 invalidateMemoryCaches(修复历史隐患)', () => {
    const text = readFile('lib/memory/dream/apply.ts');
    expect(text).toContain('invalidateMemoryCaches');
    expect(text).toContain("from '@/lib/memory/cache-invalidation'");
    expect(text).toContain('invalidateMemoryCaches(input.userId)');
  });

  it('write-gate.ts 导出 bumpMemoryVersion 且 commitMemoryWrite 内部调它', () => {
    const text = readFile('lib/memory/provider/write-gate.ts');
    expect(text).toContain('export function bumpMemoryVersion');
    // final-review B2:provider 路径的 bump 在 commitMemoryWrite 里
    expect(text).toMatch(/commitMemoryWrite[\s\S]*bumpMemoryVersion/);
  });

  // reviewer phase3 B1:extract DELETE 走裸 DAL deleteLongTermMemoryByKey,
  // 不经包装函数,需在末尾统一 invalidateMemoryCaches
  it('extract.ts 末尾调 invalidateMemoryCaches(覆盖 DELETE 裸 DAL 路径)', () => {
    const text = readFile('lib/memory/extract.ts');
    expect(text).toContain('deleteLongTermMemoryByKey'); // 确认 DELETE 路径仍在
    expect(text).toContain('invalidateMemoryCaches');
    expect(text).toContain("from '@/lib/memory/cache-invalidation'");
    // 必须条件触发(有写才失效)
    expect(text).toMatch(/if \(created \+ updated \+ deleted > 0\)/);
  });

  // reviewer phase3 B2:agentd 路由用裸 createLongTermMemoryRows(复数),
  // 不经包装函数,需显式 invalidateMemoryCaches
  it('agentd memories 路由在 createLongTermMemoryRows 后调 invalidateMemoryCaches', () => {
    const text = readFile('app/api/agentd/v1/memories/route.ts');
    expect(text).toContain('createLongTermMemoryRows'); // 确认裸 DAL 仍在
    expect(text).toContain('invalidateMemoryCaches');
    expect(text).toContain("from '@/lib/memory/cache-invalidation'");
  });
});

describe('Phase 3 失效链:version 进 cache key', () => {
  it('context-packer.ts 的 buildCacheKey 含 readMemoryVersion', () => {
    const text = readFile('lib/memory/provider/context-packer.ts');
    expect(text).toMatch(/memoryVersion.*readMemoryVersion/);
  });
});

describe('Phase 5 workflow bundle 守卫:remote-adapter 只能 import type(reviewer B1)', () => {
  it('remote-adapter.ts 对 @/lib/knowledge 顶层只用 import type(防 fetch+crypto 进 bundle)', () => {
    const text = readFile('lib/memory/provider/remote-adapter.ts');
    // 查找所有顶层 import from @/lib/knowledge
    const lines = text.split('\n');
    for (const line of lines) {
      if (/^import\s.*from\s+['"]@\/lib\/knowledge/.test(line)) {
        // 必须是 import type(不是 runtime import)
        expect(line).toMatch(/^import\s+type\s/);
      }
    }
  });
});
