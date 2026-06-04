type UpstashRedis = typeof import('@upstash/redis');
type Redis = InstanceType<UpstashRedis['Redis']>;

let _redisModulePromise: Promise<UpstashRedis> | null = null;
function loadRedisModule(): Promise<UpstashRedis> {
  if (!_redisModulePromise) {
    _redisModulePromise = import('@upstash/redis');
  }
  return _redisModulePromise;
}

let _redis: Redis | null = null;
async function getRedis(): Promise<Redis> {
  if (!_redis) {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!url || !token) {
      throw new Error(
        'KV_REST_API_URL and KV_REST_API_TOKEN env vars are required',
      );
    }
    const mod = await loadRedisModule();
    _redis = new mod.Redis({ url, token });
  }
  return _redis;
}

export const redis = new Proxy({} as Redis, {
  get(_target, prop, _receiver) {
    return async (...args: unknown[]) => {
      const instance = await getRedis();
      const value = Reflect.get(instance, prop);
      if (typeof value === 'function') {
        return (value as (...a: unknown[]) => unknown).apply(instance, args);
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

export const get = async (...args: Parameters<Redis['get']>) =>
  (await getRedis()).get(...args);
export const set = async (...args: Parameters<Redis['set']>) =>
  (await getRedis()).set(...args);
export const del = async (...args: Parameters<Redis['del']>) =>
  (await getRedis()).del(...args);
export const expire = async (...args: Parameters<Redis['expire']>) =>
  (await getRedis()).expire(...args);
export const getKV = (): Redis => redis;
