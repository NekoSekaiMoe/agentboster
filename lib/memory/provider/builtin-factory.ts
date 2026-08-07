/**
 * Builtin provider 工厂 + registry 注册。
 *
 * 设计来源:docs/memory-provider-unification-plan.md §Phase 1.4。
 * 借鉴 memoh `internal/memory/adapters/builtin/factory.go`。
 *
 * 启动时调 `registerBuiltinFactory()` 一次,之后 `getProvider(userId)`
 * 默认回退到 `__builtin__` 即拿到封箱后的 BuiltinProvider。
 *
 * 返回的 provider 经 `wrapWithWriteGate` 封箱 —— 调用方无法绕过
 * write gate(见 write-gate.ts)。
 */

import { _createBuiltinProviderInternal } from './builtin';
import { registerFactory } from './registry';
import { wrapWithWriteGate } from './write-gate';
import type { MemoryProvider, MemoryProviderFactory } from './types';

/**
 * builtin 工厂:从 config 构造封箱后的 BuiltinProvider。
 *
 * reviewer A6:工厂是拿裸 BuiltinProvider 的唯一公开入口,内部强制
 * `wrapWithWriteGate()` 封箱,只返回 `CommittedMemoryProvider`。
 * Phase 1:config 尚未承载有意义字段(embedding_model_id 等 Phase 后续接入)。
 */
const builtinFactory: MemoryProviderFactory = (id, _config) => {
  const raw = _createBuiltinProviderInternal(id);
  return wrapWithWriteGate(raw);
};

/** 是否已注册(避免重复注册,主要防测试重复 setup)。 */
let registered = false;

/**
 * 注册 builtin 工厂。幂等。
 *
 * 调用时机:服务启动时(Next.js instrumentation / 首次 import)。
 * Phase 1 先不在 instrumentation 自动调,改为显式调 —— 避免改变现有启动流程。
 * Phase 2 切 context builder 时会确保它已注册。
 */
export function registerBuiltinFactory(): void {
  if (registered) return;
  registerFactory('builtin', builtinFactory as MemoryProviderFactory);
  registered = true;
}

/** 测试用:重置注册状态。 */
export function _resetBuiltinFactoryRegistrationForTests(): void {
  registered = false;
}

// 保证类型一致:工厂返回的是封箱后的 MemoryProvider
const _typeCheck: MemoryProvider = null as unknown as Awaited<
  ReturnType<MemoryProviderFactory>
>;
void _typeCheck;
