/**
 * MemoryProviderRegistry —— per-(userId, providerId) 的 provider 实例缓存。
 *
 * 设计来源:借鉴 memoh `internal/memory/adapters/registry.go`。
 *  - 首次访问才从 DB 懒加载配置 + 工厂化(避免启动全量扫描)
 *  - Update 后驱逐,下次访问重新实例化
 *  - 并发同 key 的 cache miss 去重(in-flight promise map)
 *
 * 差异:memoh 是 per-team 多租户;agentboster 单用户多项目,用 userId 粒度足够。
 *
 * Phase 0 状态:只骨架 + builtin 工厂占位。Phase 1 才接真正的 BuiltinProvider
 * 与 DB 配置加载(`memory_providers` 表尚待建,见 Phase 1)。
 */

import type {
  MemoryProvider,
  MemoryProviderFactory,
  MemoryProviderType,
  ProviderConfig,
} from './types';
import { DEFAULT_PROVIDER_ID } from './types';

const registryKey = (userId: string, providerId: string) =>
  `${userId}:${providerId}`;

/** 已注册的工厂(按 provider type)。 */
const factories = new Map<MemoryProviderType, MemoryProviderFactory>();

/** 实例缓存(按 userId:providerId)。 */
const instanceCache = new Map<string, MemoryProvider>();

/** 进行中的实例化(去重并发 cache miss,借鉴 memoh `instantiate` 持锁)。 */
const inflight = new Map<string, Promise<MemoryProvider>>();

/**
 * 每个 key 的构造代际(reviewer A7)。
 *
 * 问题:evictProvider 只删 instanceCache 时,一个已 inflight 的 factory
 * promise 仍会在 resolve 后把旧配置实例写回 cache,且并发 getProvider 会
 * 复用这条旧 inflight —— 驱逐彻底失效。
 *
 * 解法:evict 时递增该 key 的 generation;getProvider 的 factory 回调在
 * 写 cache / 清 inflight 前校验自己仍属于当前 generation,否则丢弃。
 */
const generationByKey = new Map<string, number>();

/**
 * 注册工厂。启动时为每个 provider type 调一次。
 * 借鉴 memoh `RegisterFactory`。
 */
export function registerFactory(
  type: MemoryProviderType,
  factory: MemoryProviderFactory,
): void {
  factories.set(type, factory);
}

/**
 * 获取 provider 实例。
 *
 * Phase 0:providerId 省略时回退到 `__builtin__`(借鉴 memoh
 * `DefaultBuiltinProviderID`)。配置加载目前是占位空对象 —— Phase 1
 * 接 DB 后改为从 `memory_providers` 表读。
 */
export async function getProvider(
  userId: string,
  providerId: string = DEFAULT_PROVIDER_ID,
): Promise<MemoryProvider> {
  const key = registryKey(userId, providerId);

  const cached = instanceCache.get(key);
  if (cached) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  // 捕获当前 generation;factory 完成后校验仍属于同一 generation,
  // 否则说明中途被 evictProvider 驱逐过,丢弃旧实例(reviewer A7)。
  const generation = generationByKey.get(key) ?? 0;

  const constructing = (async () => {
    const { type, config } = await resolveProviderSpec(providerId);
    const factory = factories.get(type);
    if (!factory) {
      throw new Error(
        `MemoryProviderRegistry: no factory registered for type "${type}" (providerId=${providerId})`,
      );
    }
    const instance = await factory(providerId, config);
    // 仅当当前 generation 未变(期间未被 evict)才落 cache。
    if ((generationByKey.get(key) ?? 0) === generation) {
      instanceCache.set(key, instance);
    }
    return instance;
  })();

  inflight.set(key, constructing);
  try {
    return await constructing;
  } finally {
    // 同样校验 generation:若中途被驱逐,清掉这条 inflight;
    // 若仍属于当前 generation,正常清理(后续请求会重新构造)。
    if ((generationByKey.get(key) ?? 0) === generation) {
      inflight.delete(key);
    }
  }
}

/**
 * 驱逐缓存实例。配置更新后调用(借鉴 memoh `tryEvictAndReinstantiate`)。
 * Phase 1 的 Service 层会在 provider 行 update 后调它。
 *
 * reviewer A7:同时失效进行中的 inflight 构造 —— 递增对应 key 的
 * generation,使旧 inflight 在 resolve 时不再回填 cache 或被后续请求复用。
 */
export function evictProvider(userId: string, providerId?: string): void {
  if (providerId) {
    const key = registryKey(userId, providerId);
    instanceCache.delete(key);
    inflight.delete(key);
    generationByKey.set(key, (generationByKey.get(key) ?? 0) + 1);
    return;
  }
  // 驱逐该 userId 下全部实例:批量删 cache + inflight,并递增每个 key 的 generation
  const prefix = `${userId}:`;
  for (const key of [...instanceCache.keys(), ...inflight.keys()]) {
    if (key.startsWith(prefix)) {
      instanceCache.delete(key);
      inflight.delete(key);
      generationByKey.set(key, (generationByKey.get(key) ?? 0) + 1);
    }
  }
}

/** 清空全部缓存(仅测试用)。 */
export function clearRegistryForTests(): void {
  instanceCache.clear();
  inflight.clear();
  generationByKey.clear();
}

/** 当前已缓存的实例数(仅测试/可观测用)。 */
export function registrySize(): number {
  return instanceCache.size;
}

// ─── 配置解析(Phase 0 占位,Phase 1 接 DB)────────────────────────

interface ProviderSpec {
  type: MemoryProviderType;
  config: ProviderConfig;
}

/**
 * 从 providerId 解析出 type + config。
 *
 * Phase 0:`__builtin__` 硬编码返回 builtin + 空配置;其它 id 抛错。
 * Phase 1:改为查 `memory_providers` 表(name/provider JSON/is_default)。
 */
async function resolveProviderSpec(providerId: string): Promise<ProviderSpec> {
  if (providerId === DEFAULT_PROVIDER_ID) {
    return { type: 'builtin', config: {} };
  }
  throw new Error(
    `MemoryProviderRegistry: providerId "${providerId}" not resolvable in Phase 0 skeleton (DB config loading arrives in Phase 1)`,
  );
}
