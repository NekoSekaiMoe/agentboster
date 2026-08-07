/**
 * Memory Provider 统一抽象层 · barrel 导出。
 *
 * 见 docs/memory-provider-unification-plan.md。
 *
 * Phase 0-1 状态:
 *  - 抽象层骨架完成(types/registry/write-gate/context-packer)
 *  - BuiltinProvider 包好现有 lib/memory(不改逻辑)
 *  - 现有 lib/memory 公共 API 不变,调用方继续从 '@/lib/memory' 导入
 *  - Phase 2 才把 context builder 切到 provider
 *
 * 调用方使用:
 *   import { registerBuiltinFactory, getProvider } from '@/lib/memory/provider';
 *   registerBuiltinFactory();
 *   const provider = await getProvider(userId);
 *   const results = await provider.search(ctx, { query });
 */

export * from './types';
export * from './registry';
export * from './write-gate';
export * from './context-packer';
export * from './builtin';
export * from './builtin-factory';
