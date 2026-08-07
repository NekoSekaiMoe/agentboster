/**
 * Knowledge → PackItem 转换的单一真相源。
 *
 * 设计来源:docs/memory-provider-unification-plan.md §Phase 5 的桥接收敛。
 *
 * 历史背景:lib/memory/remote-injection.ts 曾手搓一遍 KnowledgeSearchRow →
 * PackItem 的映射(score clamp / content trim / sourceKind 兜底 / memoryId
 * 命名空间化)。抽取出来让任何想把 knowledge 结果喂给 context packer 的
 * 模块复用同一函数,杜绝再次手搓漂移。
 *
 * 信任语义(taint gate):按 `documentSourceType` 推断 ——
 * `url` → `tool_observed`(Unverified)；
 * `file`/`text`/`import` → `user_asserted`(Trusted)。
 *
 * bundle 安全:只用 `import type`,不引入运行时依赖,knowledge 模块
 * 不会反向依赖 memory provider 的运行时实现。
 */

import type { LongTermMemorySourceKind } from '@/lib/core/db/memory/long-term';
import type { KnowledgeSearchRow } from '@/lib/core/db/knowledge';
import type { PackItem } from '@/lib/memory/provider/context-packer';

/**
 * documentSourceType → sourceKind 的信任推断。
 *
 * knowledge 作为 memory 的专业特例(见讨论):其信任级别不是铁板一块,
 * 而是随来源变化 ——
 *  - file/text/import:用户主动上传/录入,等同用户断言 → user_asserted
 *  - url:connector 自动抓取,未经用户逐条确认 → tool_observed(进 Unverified 段)
 *
 * 不映射出 assistant_observed / dream_* :那是 memory 内部生命周期专用
 * (抽取/巩固/重组合),knowledge 不参与 Dream,没有这些状态。
 */
export function inferSourceKindFromSourceType(
  sourceType: KnowledgeSearchRow['documentSourceType'],
): LongTermMemorySourceKind {
  // url 是唯一自动抓取的来源;其余 file/text/import 都是用户主动提供
  if (sourceType === 'url') return 'tool_observed';
  return 'user_asserted';
}

/**
 * 把一条 knowledge 搜索命中转成 packer 可消费的 PackItem。
 *
 * 防御性归一化(对齐旧 remote-injection 的行为):
 *  - score clamp 到 [0,1](finalScore 可能因 RRF 权重略微越界)
 *  - content trim;trim 后为空返回 text='',由调用方过滤
 *  - memoryId 加 'kb:' 前缀命名空间化,避免跨 provider/memory 碰撞
 *  - sourceKind 按 documentSourceType 推断(见 inferSourceKindFromSourceType)
 */
export function knowledgeHitToPackItem(row: KnowledgeSearchRow): PackItem {
  const sourceKind = inferSourceKindFromSourceType(row.documentSourceType);
  const rawScore = Number.isFinite(row.finalScore)
    ? Math.max(0, Math.min(1, row.finalScore))
    : 0.5;
  const content = (row.content ?? '').trim();
  return {
    text: content,
    score: rawScore,
    sourceKind,
    source: 'knowledge',
    memoryId: `kb:${row.chunkId}`,
  };
}
