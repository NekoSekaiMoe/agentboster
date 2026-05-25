import { get, set } from '@/lib/core/kv';
import type { IMChatSource } from '@/types/workflow';

const DEDUP_TTL = 300;
const SIMILARITY_THRESHOLD = 0.7;

interface DedupEntry {
  text: string;
  sessionId: string;
  ts: number;
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
}

export async function checkDuplicate(
  source: IMChatSource,
  text: string,
): Promise<DedupResult | null> {
  const key = `dedup:msg:${source.adapter}:${source.userId ?? 'unknown'}`;
  const raw = await get(key);

  if (raw) {
    try {
      const entry: DedupEntry = JSON.parse(raw as string);
      const age = Date.now() - entry.ts;
      if (age < DEDUP_TTL * 1000) {
        const similarity = jaccardSimilarity(text, entry.text);
        if (similarity >= SIMILARITY_THRESHOLD) {
          return { type: 'duplicate', sessionId: entry.sessionId, similarity };
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  return null;
}

export async function recordMessage(
  source: IMChatSource,
  text: string,
  sessionId: string,
): Promise<void> {
  const key = `dedup:msg:${source.adapter}:${source.userId ?? 'unknown'}`;
  const entry: DedupEntry = { text, sessionId, ts: Date.now() };
  await set(key, JSON.stringify(entry), { ex: DEDUP_TTL });
}
