/**
 * WriteGate —— 记忆写入的单一闸口,保证版本自增不可绕过。
 *
 * 设计来源:docs/memory-provider-unification-plan.md §1.5。
 *
 * 工作方式:
 *  1. provider 的裸写方法(add/update/delete)不对外暴露
 *  2. 调用方拿到的是 `CommittedMemoryProvider`,它的写方法自动包 commitMemoryWrite
 *  3. commitMemoryWrite 执行 op → bumpMemoryVersion → 本地 listener 通知
 *
 * reviewer A3(已修复):版本号存于共享 KV 层(Upstash INCR / pg 原子 upsert),
 * 跨实例原子递增、读取一致。不再依赖进程内 Map 作为版本号唯一来源;本地 listeners
 * 仅作通知/缓存优化用途。解决多副本(serverless / 多实例)计数器不一致问题。
 *
 * 仓库约束:本文件经 provider/index.ts ← workflow context 静态可达 workflow bundle,
 * 故无顶层 node:* import;KV 层(@/lib/core/kv)同样 bundle-safe。
 */

import { incr, get as kvGet } from '@/lib/core/kv';
import type {
  MemoryPatch,
  MemoryProvider,
  MemoryRef,
  NewMemoryInput,
  ProviderWriteContext,
} from './types';

// ─── 共享版本计数器(KV 层原子递增)──────────────────────────

/** 版本号在 KV 中的键空间。仅 incr 写入数字字符串,不与 JSON 值冲突。 */
function versionKey(userId: string): string {
  return `memory_version:${userId}`;
}

/** 订阅者(本地通知/缓存优化,不作版本号来源 —— 版本号唯一来源是 KV)。 */
type VersionListener = (userId: string, newVersion: number) => void;
const listeners = new Set<VersionListener>();

/**
 * 读当前版本号(从共享 KV)。ContextPacker 的 cache key 含此值 —— 任何写入使其失效。
 *
 * 返回 0 当键不存在(新用户/从未写入)。KV 存数字字符串,这里 parseInt。
 */
export async function readMemoryVersion(userId: string): Promise<number> {
  const raw = await kvGet(versionKey(userId));
  if (raw === null || raw === undefined) return 0;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 原子自增版本号(共享 KV),返回新值。
 *
 * **调用约定**:在以下三处调用,覆盖所有写路径:
 *  1. `commitMemoryWrite`(provider 路径,本文件)
 *  2. `invalidateMemoryCaches`(Dream / 裸 DAL 路径,cache-invalidation.ts)
 *  3. long-term.ts 的 4 个写函数内部(reviewer A1:保证任何直调该函数的调用方都 bump)
 *
 * 多处 bump 是有意的冗余 —— version 单调递增,多 bump 只会多失效一次缓存,
 * 不会错。漏 bump 才是错误(缓存 stale)。
 */
export async function bumpMemoryVersion(userId: string): Promise<number> {
  const next = await incr(versionKey(userId));
  for (const listener of listeners) {
    try {
      listener(userId, next);
    } catch {
      // listener 故障不影响主写(fire-and-forget)
    }
  }
  return next;
}

/**
 * 写入闸口:保证 op 执行 + 版本 bump。
 *
 * provider 路径在这里 bump。非 provider 路径(extract/dream/裸 DAL)由
 * long-term.ts 内部 bump + invalidateMemoryCaches 兜底。多处 bump 单调递增、
 * 安全冗余。见 docs/memory-provider-unification-plan.md §1.5 + reviewer A1。
 */
export async function commitMemoryWrite(
  ctx: ProviderWriteContext,
  op: () => Promise<void>,
): Promise<void> {
  await op();
  // provider 路径统一 bump(op 内部的 upsertLongTermMemory 也会 bump,
  // 此处再多一次是安全冗余 —— 保持 provider-neutral,不依赖 inner 实现 bump)。
  await bumpMemoryVersion(ctx.userId);
}

/** 订阅版本变化(测试 / 本地缓存优化用)。 */
export function onMemoryVersionChange(listener: VersionListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 清空本地 listener(仅测试用)。共享 KV 中的版本号由测试自行 mock/重置
 * (生产中从不重置 —— 版本号单调递增跨进程共享)。
 */
export function clearWriteGateForTests(): void {
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
  // reviewer A4:函数属性必须先 bind 到 target,否则通过解构调用
  // (`const { search } = provider; search(...)`)或经由 Proxy 调用时
  // `this` 不再指向原始实例,导致 `this.deps` 等私有字段读成 undefined。
  // 非函数属性按原 Reflect.get 行为返回。
  return new Proxy(inner, {
    get(target, prop, _receiver) {
      if (prop === 'add') return committedAdd;
      if (prop === 'update') return committedUpdate;
      if (prop === 'delete') return committedDelete;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as CommittedMemoryProvider;
}
