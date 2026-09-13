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

export async function getSpill(
  spillId: string,
  expectedSessionId?: string,
): Promise<StoredSpill | null> {
  'use step';

  const kv = await import('@/lib/core/kv');
  const value = await kv.get(spillKey(spillId));
  if (!value || typeof value !== 'object') return null;
  const record = value as StoredSpill;
  if (typeof record.text !== 'string') return null;
  // Integrity: fetch_spilled_output computes paging metadata off totalChars
  // (original output length) vs storedChars. A corrupt record with a
  // missing/non-integer totalChars would report `totalChars: undefined` and
  // a wrong truncatedInStore (`undefined > n` === false) — treat it like a
  // missing record instead.
  if (
    typeof record.totalChars !== 'number' ||
    !Number.isSafeInteger(record.totalChars) ||
    record.totalChars < record.text.length
  ) {
    return null;
  }
  // Ownership: spill ids surface in model-visible notes, so a
  // prompt-injected or cross-session caller must not be able to read
  // another session's output. Fail closed on a missing owner (records
  // predating ownership binding) and return the same "not found" shape so
  // the existence of a foreign spill is never confirmed.
  if (
    expectedSessionId !== undefined &&
    record.sessionId !== expectedSessionId
  ) {
    return null;
  }
  return record;
}
