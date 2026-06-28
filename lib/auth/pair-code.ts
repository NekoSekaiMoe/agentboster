/**
 * In-memory pair code store.
 *
 * Pair codes are one-shot, short-lived (5 min) tokens that the web
 * UI issues for an authenticated user. The user pastes the code into
 * `agentboster login --pair-code <code>` on their CLI, which exchanges
 * it for a full auth token via POST /api/auth/pair-exchange.
 *
 * In-memory is sufficient: pair codes are ephemeral and single-node
 * (Vercel serverless functions persist for the duration of one
 * invocation, but the generate + exchange happen in separate requests
 * — so we need a backing store. For production multi-instance deploys,
 * move this to KV/Redis. For now we store in the DB session metadata
 * or a simple KV key).
 */

import {
  get as kvGet,
  set as kvSet,
  del as kvDel,
  expire as kvExpire,
} from '@/lib/core/kv';

const PAIR_CODE_PREFIX = 'pair-code:';
const PAIR_CODE_TTL_SECONDS = 300; // 5 minutes

export interface PairCodeEntry {
  userId: string;
  username: string;
  label?: string;
  createdAt: number;
}

/**
 * Generate a one-shot pair code for a user.
 * Returns the code string (format: XXXX-XXXX, alphanumeric).
 */
export async function generatePairCode(input: {
  userId: string;
  username: string;
  label?: string;
}): Promise<string> {
  const code = generateCodeString();
  const entry: PairCodeEntry = {
    userId: input.userId,
    username: input.username,
    label: input.label,
    createdAt: Date.now(),
  };
  await kvSet(`${PAIR_CODE_PREFIX}${code}`, JSON.stringify(entry));
  await kvExpire(`${PAIR_CODE_PREFIX}${code}`, PAIR_CODE_TTL_SECONDS);
  return code;
}

/**
 * Exchange a pair code for user info. Consumes the code (one-shot).
 * Returns null if the code is invalid, expired, or already used.
 */
export async function consumePairCode(
  code: string,
): Promise<PairCodeEntry | null> {
  const key = `${PAIR_CODE_PREFIX}${code}`;
  const raw = await kvGet(key);
  if (raw === null || raw === undefined) return null;
  // Delete immediately (one-shot).
  await kvDel(key);
  try {
    return JSON.parse(raw as string) as PairCodeEntry;
  } catch {
    return null;
  }
}

function generateCodeString(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
    if (i === 3) code += '-';
  }
  return code;
}
