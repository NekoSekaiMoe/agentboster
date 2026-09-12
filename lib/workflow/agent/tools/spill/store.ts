/**
 * Spill KV storage — durable step helpers.
 *
 * Uses the same dynamic-import-inside-'use step' pattern as every other
 * host-touching tool helper (see tools/execute/sanbox.ts): the workflow
 * DevKit bundler must not see `@/lib/core/kv` as a static dependency of the
 * workflow bundle, and KV writes must replay deterministically (same key,
 * same value — idempotent under replay).
 */
import { spillKey, type StoredSpill } from './core';

export async function putSpill(
  spillId: string,
  record: StoredSpill,
  ttlSeconds: number,
): Promise<void> {
  'use step';

  const kv = await import('@/lib/core/kv');
  await kv.set(spillKey(spillId), record, { ex: ttlSeconds });
}

export async function getSpill(spillId: string): Promise<StoredSpill | null> {
  'use step';

  const kv = await import('@/lib/core/kv');
  const value = await kv.get(spillKey(spillId));
  if (!value || typeof value !== 'object') return null;
  const record = value as StoredSpill;
  if (typeof record.text !== 'string') return null;
  return record;
}
