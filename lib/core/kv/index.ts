import { createRedisState } from '@chat-adapter/state-redis';
import { Redis } from '@upstash/redis';

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.KV_REST_API_URL!,
      token: process.env.KV_REST_API_TOKEN!,
    });
  }
  return _redis;
}

export const redis = new Proxy({} as Redis, {
  get(_target, prop, receiver) {
    return Reflect.get(getRedis(), prop, receiver);
  },
});

let _redisState: ReturnType<typeof createRedisState> | null = null;

export const redisState = new Proxy({} as ReturnType<typeof createRedisState>, {
  get(_target, prop, receiver) {
    if (!_redisState) {
      _redisState = createRedisState({
        url: process.env.KV_REST_API_URL!,
      });
    }
    return Reflect.get(_redisState, prop, receiver);
  },
});

export const get = (...args: Parameters<Redis['get']>) => getRedis().get(...args);
export const set = (...args: Parameters<Redis['set']>) => getRedis().set(...args);
export const del = (...args: Parameters<Redis['del']>) => getRedis().del(...args);
export const expire = (...args: Parameters<Redis['expire']>) => getRedis().expire(...args);
export const getKV = () => getRedis();
