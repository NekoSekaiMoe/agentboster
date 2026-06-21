import { redis } from './index';

const DEFAULT_LOCK_TTL_MS = 30_000;
const DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS = 15_000;
const DEFAULT_LOCK_POLL_INTERVAL_MS = 250;
const LOCK_KEY_PREFIX = 'lock:';
const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

export interface KvLockOptions {
  ttlMs?: number;
  acquireTimeoutMs?: number;
  pollIntervalMs?: number;
}

function normalizeLockKey(key: string): string {
  const trimmedKey = key.trim();
  if (!trimmedKey) {
    throw new Error('Lock key is required.');
  }

  return trimmedKey.startsWith(LOCK_KEY_PREFIX)
    ? trimmedKey
    : `${LOCK_KEY_PREFIX}${trimmedKey}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function acquireKvLock(
  key: string,
  options: Required<KvLockOptions>,
): Promise<{ key: string; token: string }> {
  const normalizedKey = normalizeLockKey(key);
  const { randomUUID } = await import('node:crypto');
  const token = randomUUID();
  const deadline = Date.now() + options.acquireTimeoutMs;

  while (Date.now() < deadline) {
    const acquired = await redis.set(normalizedKey, token, {
      nx: true,
      px: options.ttlMs,
    });

    if (acquired === 'OK') {
      return { key: normalizedKey, token };
    }

    await sleep(options.pollIntervalMs);
  }

  throw new Error(`Timed out acquiring KV lock for key "${normalizedKey}".`);
}

async function releaseKvLock(key: string, token: string): Promise<void> {
  await redis.eval(RELEASE_LOCK_SCRIPT, [key], [token]);
}

export async function withKvLock<T>(
  key: string,
  action: () => Promise<T>,
  options?: KvLockOptions,
): Promise<T> {
  const resolvedOptions: Required<KvLockOptions> = {
    ttlMs: options?.ttlMs ?? DEFAULT_LOCK_TTL_MS,
    acquireTimeoutMs:
      options?.acquireTimeoutMs ?? DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS,
    pollIntervalMs: options?.pollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS,
  };

  const lock = await acquireKvLock(key, resolvedOptions);

  try {
    return await action();
  } finally {
    await releaseKvLock(lock.key, lock.token);
  }
}
