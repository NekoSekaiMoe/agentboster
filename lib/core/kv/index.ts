import { Redis } from '@upstash/redis';

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (!_redis) {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!url || !token) {
      throw new Error(
        'KV_REST_API_URL and KV_REST_API_TOKEN env vars are required',
      );
    }
    _redis = new Redis({
      url,
      token,
    });
  }
  return _redis;
}

export const redis = new Proxy({} as Redis, {
  get(_target, prop, receiver) {
    return Reflect.get(getRedis(), prop, receiver);
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

export const get = (...args: Parameters<Redis['get']>) =>
  getRedis().get(...args);
export const set = (...args: Parameters<Redis['set']>) =>
  getRedis().set(...args);
export const del = (...args: Parameters<Redis['del']>) =>
  getRedis().del(...args);
export const expire = (...args: Parameters<Redis['expire']>) =>
  getRedis().expire(...args);
export const getKV = () => getRedis();
