import { isVercel } from '@/lib/extra/deploy';

/**
 * KV layer with two interchangeable backends, selected by deployment mode:
 *
 *  - Vercel  → Upstash Redis over HTTP (`@upstash/redis`, `KV_REST_API_*`).
 *  - Self-hosted → Postgres-backed shim (`./pg-backend`, `kv_store`/`kv_sets`).
 *
 * Both expose the same call surface the app uses (get/set/del/expire/eval/
 * sadd/srem/smembers/ttl) with identical return contracts, so every call site
 * — and the `redis` proxy below — is agnostic to which one is live.
 *
 * `redisState` (chat-adapter session state) is UNCHANGED: it always uses a
 * plain `REDIS_URL` TCP Redis via `@chat-adapter/state-redis`, which works the
 * same on Vercel and self-hosted. It is a separate concern from this KV shim.
 *
 * IMPORTANT: this module is statically reachable from the workflow bundle (via
 * config.ts ← workflow context). Keep top-level imports bundle-safe: the pg
 * backend only touches drizzle, and Upstash is loaded via `await import()`.
 */

type UpstashRedis = typeof import('@upstash/redis');
type Redis = InstanceType<UpstashRedis['Redis']>;

let _redisModulePromise: Promise<UpstashRedis> | null = null;
function loadRedisModule(): Promise<UpstashRedis> {
  if (!_redisModulePromise) {
    _redisModulePromise = import('@upstash/redis');
  }
  return _redisModulePromise;
}

let _upstash: Redis | null = null;
async function getUpstash(): Promise<Redis> {
  if (!_upstash) {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!url || !token) {
      throw new Error(
        'KV_REST_API_URL and KV_REST_API_TOKEN env vars are required',
      );
    }
    const mod = await loadRedisModule();
    _upstash = new mod.Redis({ url, token });
  }
  return _upstash;
}

/**
 * Build the Postgres-backed KV object shaped like the subset of the Upstash
 * `Redis` interface the app uses. Loaded lazily so the pg backend (and its db
 * dependency) is only imported when actually on the self-hosted path.
 */
async function getPgKv() {
  const b = await import('./pg-backend');
  return {
    get: b.pgGet,
    set: b.pgSet,
    del: b.pgDel,
    expire: b.pgExpire,
    eval: b.pgEval,
    sadd: b.pgSadd,
    srem: b.pgSrem,
    smembers: b.pgSmembers,
    ttl: b.pgTtl,
  };
}

type KvBackend = {
  get: (key: string) => Promise<unknown>;
  set: (
    key: string,
    value: unknown,
    options?: { nx?: boolean; xx?: boolean; ex?: number; px?: number },
  ) => Promise<'OK' | null>;
  del: (...keys: string[]) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<number>;
  eval: (script: string, keys: string[], args: string[]) => Promise<unknown>;
  sadd: (key: string, ...members: string[]) => Promise<number>;
  srem: (key: string, ...members: string[]) => Promise<number>;
  smembers: (key: string) => Promise<string[]>;
  ttl: (key: string) => Promise<number>;
};

let _backendPromise: Promise<KvBackend> | null = null;
function getBackend(): Promise<KvBackend> {
  if (!_backendPromise) {
    _backendPromise = isVercel
      ? (getUpstash() as unknown as Promise<KvBackend>)
      : (getPgKv() as unknown as Promise<KvBackend>);
  }
  return _backendPromise;
}

/**
 * A Redis-like proxy that forwards each method call to whichever backend is
 * active. Callers use `redis.set(...)`, `redis.eval(...)`, `redis.sadd(...)`,
 * etc. exactly as before.
 */
export const redis = new Proxy({} as Redis, {
  get(_target, prop, _receiver) {
    // Thenable guard: if anything awaits this proxy (Promise.resolve(redis),
    // a runtime probing for a `.then`), returning an async function for `then`
    // would make the proxy look like a never-settling promise and hang. Return
    // undefined so it's treated as a plain object. Same for any symbol prop
    // (e.g. Symbol.toPrimitive / util.inspect) — those aren't backend methods.
    if (prop === 'then' || typeof prop === 'symbol') return undefined;
    return async (...args: unknown[]) => {
      const backend = await getBackend();
      const value = Reflect.get(backend as object, prop);
      if (typeof value === 'function') {
        return (value as (...a: unknown[]) => unknown).apply(backend, args);
      }
      return value;
    };
  },
});

type RedisStateModule = typeof import('@chat-adapter/state-redis');
type RedisState = ReturnType<RedisStateModule['createRedisState']>;

let _redisStatePromise: Promise<RedisState> | null = null;
function loadRedisState(): Promise<RedisState> {
  if (!_redisStatePromise) {
    _redisStatePromise = import('@chat-adapter/state-redis').then((mod) => {
      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) {
        throw new Error('REDIS_URL env var is required');
      }
      return mod.createRedisState({ url: redisUrl });
    });
  }
  return _redisStatePromise;
}

export const redisState = new Proxy({} as RedisState, {
  get(_target, prop, _receiver) {
    // Same thenable guard as `redis` above — don't let an await hang on this.
    if (prop === 'then' || typeof prop === 'symbol') return undefined;
    return async (...args: unknown[]) => {
      const state = await loadRedisState();
      const value = Reflect.get(state, prop);
      if (typeof value === 'function') {
        return (value as (...a: unknown[]) => unknown).apply(state, args);
      }
      return value;
    };
  },
});

export const get = async (key: string) => (await getBackend()).get(key);
export const set = async (
  key: string,
  value: unknown,
  options?: { nx?: boolean; xx?: boolean; ex?: number; px?: number },
) => (await getBackend()).set(key, value, options);
export const del = async (...keys: string[]) =>
  (await getBackend()).del(...keys);
export const expire = async (key: string, seconds: number) =>
  (await getBackend()).expire(key, seconds);
export const getKV = (): Redis => redis;
