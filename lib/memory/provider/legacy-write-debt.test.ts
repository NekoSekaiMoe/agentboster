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
  it('legacy 直调文件不超出 allowlist(reviewer D7:显式清单替代数字基线)', () => {
    const { files } = countLegacyDirectDALWrites();
    // reviewer D7:用显式 allowlist 替代数字 BASELINE ——
    // 新增直调点必须显式入册,否则测试失败提示走 provider。
    // Phase 3 把 extract/dream 改走 provider 后可从 allowlist 删除对应条目。
    const ALLOWLIST = new Set([
      'lib/memory/dream/apply.ts',
      'lib/memory/extract.ts',
      'lib/memory/long-term.ts', // 内部包装层,直调 DAL 是设计
      'lib/workflow/agent/tools/memories/local.ts',
      'app/(memory)/actions.ts',
      'app/api/agentd/v1/memories/route.ts',
      'app/api/agentd/v1/memories/[id]/route.ts', // agentd PUT/DELETE 路由, ownership 推导后直调 update/deleteLongTermMemoryRow
      'app/api/import/route.ts',
    ]);
    const unexpected = files.filter((f) => !ALLOWLIST.has(f));
    if (unexpected.length > 0) {
      expect.fail(
        `检测到未入册的 memory 写 DAL 直调文件:\n${unexpected.join('\n')}\n` +
          `新代码请走 MemoryProvider(write-gate.ts),不要直调 upsertLongTermMemory 等。\n` +
          `若确需新增 legacy 直调,请显式加入本测试 ALLOWLIST 并说明理由。`,
      );
    }

    // 反向校验防腐化:ALLOWLIST 每项必须仍被 countLegacyDirectDALWrites() 返回
    // (即该文件确实含 DAL 直调)。某文件改走 provider 后若忘从 ALLOWLIST 删除,
    // 扫描器不再返回它 → 这里报错提示清理,避免 allowlist 静默腐化。
    const returned = new Set(files);
    const stale = [...ALLOWLIST].filter((f) => !returned.has(f));
    if (stale.length > 0) {
      expect.fail(
        `ALLOWLIST 中存在已不再直调 DAL 的文件(应删除):\n${stale.join('\n')}\n` +
          `这些文件已不在 countLegacyDirectDALWrites() 返回列表中,` +
          `说明它们已改走 MemoryProvider 或被删除。请从 ALLOWLIST 移除以保持同步。`,
      );
    }
  });
});
