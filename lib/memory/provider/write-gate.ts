/**
 * WriteGate —— 记忆写入的单一闸口,保证版本自增不可绕过。
 *
 * 设计来源:docs/memory-provider-unification-plan.md §1.5。
 *
 * 解决的核心问题:"删除手动缓存失效、改用 MemoryVersion" 会引入
 * "某个写路径忘记自增 → 静默 stale" 的风险。靠"测试覆盖所有写入口"是
 * 赌运气;真正的解法是把自增点收缩成唯一的、不可绕过的结构层入口。
 *
 * 工作方式:
 *  1. provider 的裸写方法(add/update/delete)不对外暴露
 *  2. 调用方拿到的是 `CommittedMemoryProvider`,它的写方法自动包 commitMemoryWrite
 *  3. commitMemoryWrite 执行 op → bumpMemoryVersion(唯一调用点)→ 跨进程通知
 *  4. 全 codebase 只有本文件一个 bumpMemoryVersion 调用点(lint 守护)
 *
 * Phase 0 状态:只骨架。
 *  - 版本计数器是进程内内存变量(Phase 3 会加 memory_version_log 表落库)
 *  - 跨进程通知 Phase 3 接(Vercel 用 Upstash pub-sub,自托管用 pg NOTIFY)
 *  - 本文件遵守 workflow bundle 规则:无顶层 node:* import
 */

import type {
  MemoryPatch,
  MemoryProvider,
  MemoryRef,
  NewMemoryInput,
  ProviderWriteContext,
} from './types';

// ─── 进程内版本计数器(Phase 3 会镜像到 DB)──────────────────────

/** key: userId,value: 当前版本号(单调递增)。 */
const versionByUser = new Map<string, number>();

/** 订阅者(跨进程通知 Phase 3 接,这里留 hook)。 */
type VersionListener = (userId: string, newVersion: number) => void;
const listeners = new Set<VersionListener>();

/**
 * 读当前版本号。
 * ContextPacker 的 cache key 含此值 —— 任何写入使其失效。
 */
export function readMemoryVersion(userId: string): number {
  return versionByUser.get(userId) ?? 0;
}

/**
 * 自增版本号。
 *
 * **调用约定**:Phase 3 起,唯一合法调用方是 `invalidateMemoryCaches()`
 * (lib/memory/cache-invalidation.ts)。这样不管写路径经不经 provider
 * (extract / dream / agent-tool / provider.add),只要调了失效就 bump,
 * 解决 phase1-review #1 的"Dream/extract 绕过 write-gate"空洞。
 *
 * `commitMemoryWrite` 不再直接调它 —— op 内部的失效会调。如果 op 完全
 * 不失效(纯 DAL 直写),那也不该 bump(没失效 = 没变)。
 *
 * legacy-write-debt.test.ts 钉住了 legacy 直调点清单;新代码请走
 * MemoryProvider,并在写后调 invalidateMemoryCaches。
 */
export function bumpMemoryVersion(userId: string): number {
  const next = (versionByUser.get(userId) ?? 0) + 1;
  versionByUser.set(userId, next);
  for (const listener of listeners) {
    try {
      listener(userId, next);
    } catch {
      // listener 故障不影响主写(借鉴现有 cache 失效 fire-and-forget 模式)
    }
  }
  return next;
}

/**
 * 写入闸口:保证 op 执行 + 失效触发。
 *
 * Phase 3 语义变更:bump 不在这里做,而是由 op 内部触发的
 * `invalidateMemoryCaches()` 负责。理由:很多写路径(extract / dream)
 * 直调 upsertLongTermMemory 而不经 provider,但它们都会触发失效。
 * 把 bump 挂在失效层比挂在 write-gate 覆盖面更广。
 * 见 phase1-review #1 + docs/memory-provider-unification-plan.md §1.5。
 *
 * 本函数仍保留作为 provider 写方法的包装层(未来可加事务/重试/观测),
 * 但不再保证"调它必 bump"。
 */
export async function commitMemoryWrite(
  ctx: ProviderWriteContext,
  op: () => Promise<void>,
): Promise<void> {
  await op();
  // final-review B2:bump 责任层统一。
  // provider 路径(经 write-gate)在这里 bump;非 provider 路径(extract/dream/agentd)
  // 在其末尾的 invalidateMemoryCaches 里 bump。两条路径互斥,不重复 bump。
  bumpMemoryVersion(ctx.userId);
}

/** 订阅版本变化(测试 / Phase 3 跨进程通知用)。 */
export function onMemoryVersionChange(listener: VersionListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 清空全部版本状态(仅测试用)。 */
export function clearWriteGateForTests(): void {
  versionByUser.clear();
  listeners.clear();
}

// ─── CommittedMemoryProvider:对外暴露的封箱 provider ──────────────

/**
 * 把裸 provider 封箱:写方法自动走 write gate。
 *
 * 调用方从 registry 拿到的 provider 应先经 `wrapWithWriteGate()` 封箱,
 * 这样调用方**无法**绕过 write gate 直接调裸写。
 *
 * 注意:Phase 0 骨架只封 add/update/delete 三个写方法;onAfterChat
 * (它内部也会写)在 Phase 1 接入时再包。
 */
export interface CommittedMemoryProvider extends MemoryProvider {
  /** 已封箱,与 MemoryProvider 同签名。 */
}

export function wrapWithWriteGate(
  inner: MemoryProvider,
): CommittedMemoryProvider {
  const committedAdd = async (
    ctx: ProviderWriteContext,
    mem: NewMemoryInput,
  ): Promise<MemoryRef> => {
    let ref: MemoryRef | undefined;
    await commitMemoryWrite(ctx, async () => {
      ref = await inner.add(ctx, mem);
    });
    return ref ?? { id: '', key: mem.key };
  };

  const committedUpdate = async (
    ctx: ProviderWriteContext,
    id: string,
    patch: MemoryPatch,
  ): Promise<void> => {
    await commitMemoryWrite(ctx, () => inner.update(ctx, id, patch));
  };

  const committedDelete = async (
    ctx: ProviderWriteContext,
    ids: string[],
  ): Promise<void> => {
    await commitMemoryWrite(ctx, () => inner.delete(ctx, ids));
  };

  // 代理其余方法(检索 + 可选钩子直传)
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'add') return committedAdd;
      if (prop === 'update') return committedUpdate;
      if (prop === 'delete') return committedDelete;
      return Reflect.get(target, prop, receiver);
    },
  }) as CommittedMemoryProvider;
}
