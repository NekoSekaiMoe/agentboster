import { createRedisState } from '@chat-adapter/state-redis';
import { Redis } from '@upstash/redis';

// biome-ignore lint/style/noNonNullAssertion: KV URL is required
const REDIS_URL = process.env.KV_REST_API_URL!;
// biome-ignore lint/style/noNonNullAssertion: KV API Token is required
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN!;

export const redis = new Redis({
  url: REDIS_URL,
  token: REDIS_TOKEN,
});

/**
 * Redis State for Chat SDK
 */
export const redisState = createRedisState();
export const { get, set, del, expire } = redis;
export const getKV = () => redis;
