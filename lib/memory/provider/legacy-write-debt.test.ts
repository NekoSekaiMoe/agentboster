/**
 * Phase 1 债务守卫(reviewer phase1-review #1)。
 *
 * 问题:Dream / extract 当前直调 upsertLongTermMemory / upsertLongTermMemoryByKey /
 * deleteLongTermMemoryRow,绕过 MemoryProvider 抽象层。这意味着 write-gate 的
 * "唯一写入闸口"承诺在生产里只覆盖了 provider.add/update/delete 这一小部分写,
 * 而占写入绝大多数的 extract(每轮对话)和 Dream(每次运行)都不 bump version。
 *
 * Phase 1 的处理:**先用测试把债务钉死**,防止新代码继续直调;真正把 extract/dream
 * 改走 provider 是 Phase 3 的工作(见 docs/memory-provider-unification-plan.md
 * §Phase 3 的三入口清单)。
 *
 * 本测试不阻止已知的 legacy 直调(那会破构建),只阻止**新增**直调。
 * 办法:断言当前 legacy 直调点数量的基线值,新增任何直调都会让计数超过基线、测试失败,
 * 提示开发者走 provider。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 统计 lib/(不含 provider/) 里直调 memory DAL 写函数的文件数。 */
function countLegacyDirectDALWrites(): { files: string[]; count: number } {
  const targets = [
    'upsertLongTermMemory',
    'upsertLongTermMemoryByKey',
    'deleteLongTermMemoryRow',
    'deleteLongTermMemoryByKey',
    'updateLongTermMemoryRow',
    'createLongTermMemoryRow',
    'createLongTermMemoryRows', // final-review S1:复数裸 DAL(agentd 路由用)
  ];

  const offenders: string[] = [];
  const root = join(process.cwd(), 'lib');

  function walk(dir: string) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const rel = full.replace(`${process.cwd()}/`, '');
      // 跳过 provider/ 抽象层本身、DAL 定义文件、测试文件
      if (rel.startsWith('lib/memory/provider/')) continue;
      if (rel.includes('/db/memory/')) continue; // DAL 层定义
      if (rel.endsWith('.test.ts')) continue;

      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (name !== 'node_modules') walk(full);
        continue;
      }
      if (!name.endsWith('.ts')) continue;
      const text = readFileSync(full, 'utf8');
      // 引用任意一个写 DAL 函数(import 或调用)
      for (const t of targets) {
        const importPattern = new RegExp(`\\b${t}\\b`);
        if (importPattern.test(text)) {
          offenders.push(rel);
          break;
        }
      }
    }
  }
  walk(root);
  // final-review S1:也扫 app/(agentd 路由在 app/api/agentd/)
  walk(join(process.cwd(), 'app'));
  return { files: [...new Set(offenders)], count: new Set(offenders).size };
}

describe('Phase 1 债务守卫:memory 写 DAL 的 legacy 直调点', () => {
  it('legacy 直调文件数不超过基线(防止新增直调)', () => {
    const { files, count } = countLegacyDirectDALWrites();
    // 基线值:Phase 1 结束时已知 legacy 直调文件清单。
    // 新增直调 → 计数上升 → 测试失败 → 提示走 provider。
    // 减少(Phase 3 把 extract/dream 改走 provider) → 更新基线下调。
    // final-review S1:基线含所有 legacy 直调点(扫描 lib/ + app/)
    // dream/apply, extract, long-term(内部), workflow/tools/local,
    // (memory)/actions, agentd/memories, api/import
    const BASELINE = 7;
    if (count > BASELINE) {
      expect.fail(
        `memory 写 DAL 直调文件数 ${count} 超过基线 ${BASELINE}。\n` +
          `新增直调点:\n${files.join('\n')}\n` +
          `新代码请走 MemoryProvider(write-gate.ts),不要直调 upsertLongTermMemory 等。\n` +
          `(Phase 3 会把 legacy 的 extract/dream 改走 provider。)`,
      );
    }
    // 反向:基线下调时也要更新本测试,提醒评审
    expect(count).toBeLessThanOrEqual(BASELINE);
  });
});
