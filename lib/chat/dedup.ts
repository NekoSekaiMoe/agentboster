import { get, set } from '@/lib/core/kv';
import type { IMChatSource } from '@/types/workflow';

const DEDUP_TTL = 300;
const SIMILARITY_THRESHOLD = 0.7;

interface DedupEntry {
  text: string;
  sessionId: string;
  ts: number;
  messageId?: string;
  idempotencyKey?: string;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text: string): Set<string> {
  return new Set(normalizeText(text).split(' ').filter(Boolean));
}

function jaccardSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface DedupResult {
  type: 'duplicate';
  sessionId: string;
  similarity: number;
  reason: 'message_id' | 'idempotency_key' | 'similarity';
}

export interface DedupOptions {
  messageId?: string;
  idempotencyKey?: string;
  skipDedup?: boolean;
}

function scopedSourceKey(source: IMChatSource): string {
  return `dedup:msg:${source.adapter}:${source.userId ?? 'unknown'}`;
}

async function checkExactKey(
  key: string,
  reason: DedupResult['reason'],
): Promise<DedupResult | null> {
  const raw = await get(key);
  if (!raw) {
    return null;
  }

  try {
    const entry: DedupEntry = JSON.parse(raw as string);
    return {
      type: 'duplicate',
      sessionId: entry.sessionId,
      similarity: 1,
      reason,
    };
  } catch {
    return null;
  }
}

export async function checkDuplicate(
  source: IMChatSource,
  text: string,
  options: DedupOptions = {},
): Promise<DedupResult | null> {
  if (options.skipDedup) {
    return null;
  }

  if (options.messageId) {
    const duplicate = await checkExactKey(
      `dedup:platform:${source.adapter}:${options.messageId}`,
      'message_id',
    );
    if (duplicate) return duplicate;
  }

  if (options.idempotencyKey) {
    const duplicate = await checkExactKey(
      `dedup:idempotency:${options.idempotencyKey}`,
      'idempotency_key',
    );
    if (duplicate) return duplicate;
  }

  const key = scopedSourceKey(source);
  const raw = await get(key);

  if (raw) {
    try {
      const entry: DedupEntry = JSON.parse(raw as string);
      const age = Date.now() - entry.ts;
      if (age < DEDUP_TTL * 1000) {
        const similarity = jaccardSimilarity(text, entry.text);
        if (similarity >= SIMILARITY_THRESHOLD) {
          return {
            type: 'duplicate',
            sessionId: entry.sessionId,
            similarity,
            reason: 'similarity',
          };
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  return null;
}

export async function checkIdempotencyDuplicate(
  idempotencyKey: string,
): Promise<DedupResult | null> {
  return checkExactKey(
    `dedup:idempotency:${idempotencyKey}`,
    'idempotency_key',
  );
}

export async function recordMessage(
  source: IMChatSource,
  text: string,
  sessionId: string,
  options: DedupOptions = {},
): Promise<void> {
  if (options.skipDedup) {
    return;
  }

  const entry: DedupEntry = {
    text,
    sessionId,
    ts: Date.now(),
    messageId: options.messageId,
    idempotencyKey: options.idempotencyKey,
  };

  const writes: Array<Promise<unknown>> = [
    set(scopedSourceKey(source), JSON.stringify(entry), { ex: DEDUP_TTL }),
  ];

  if (options.messageId) {
    writes.push(
      set(
        `dedup:platform:${source.adapter}:${options.messageId}`,
        JSON.stringify(entry),
        { ex: DEDUP_TTL },
      ),
    );
  }

  if (options.idempotencyKey) {
    writes.push(
      set(
        `dedup:idempotency:${options.idempotencyKey}`,
        JSON.stringify(entry),
        { ex: DEDUP_TTL },
      ),
    );
  }

  await Promise.all(writes);
}

export async function recordIdempotencyMessage(
  idempotencyKey: string,
  text: string,
  sessionId: string,
): Promise<void> {
  const entry: DedupEntry = {
    text,
    sessionId,
    ts: Date.now(),
    idempotencyKey,
  };
  await set(`dedup:idempotency:${idempotencyKey}`, JSON.stringify(entry), {
    ex: DEDUP_TTL,
  });
}
