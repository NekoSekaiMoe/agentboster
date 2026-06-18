import { searchLongTermMemories } from './long-term';

/**
 * Default number of long-term memories to auto-inject into the agent's
 * context per turn. Kept small to avoid drowning out the conversation
 * while still surfacing the most relevant personal context (location,
 * preferences, recent decisions). Tuned to match what a thoughtful
 * human assistant would keep in working memory.
 */
export const DEFAULT_RECALL_TOP_K = 5;

/**
 * Minimum normalised RRF score (0-1, see lib/memory/search.ts) for an
 * auto-recalled memory to be injected. Lower than the readMemory tool's
 * 0.05 default because auto-injection is best-effort: better to surface
 * a marginal match (the agent can ignore it) than to miss the relevant
 * fact entirely.
 */
export const DEFAULT_RECALL_MIN_CONFIDENCE = 0.02;

export interface RecalledMemory {
  content: string;
  score: number;
}

/**
 * Retrieve the top-K long-term memories relevant to a user's latest
 * message. Designed for auto-injection into the agent's context — the
 * agent never has to call readMemory proactively for personal-context
 * queries (location, preferences, schedule, etc.).
 *
 * Best-effort: returns an empty array when the user is anonymous, the
 * query is empty, the embedding model is not configured, or search
 * throws. Never rejects — callers can await without try/catch.
 *
 * @param userId  The user memories are scoped to. When null/undefined,
 *                returns [] (anonymous sessions have no long-term memories).
 * @param query   The user's latest message text. Multi-sentence messages
 *                are passed verbatim; the embedding model handles phrasing.
 * @param topK    Max memories to return. Defaults to DEFAULT_RECALL_TOP_K.
 */
export async function recallRelevantMemories(input: {
  userId?: string | null;
  query?: string | null;
  topK?: number;
  minConfidence?: number;
}): Promise<RecalledMemory[]> {
  const userId = input.userId ?? null;
  const query = input.query?.trim();
  const topK = Math.max(1, input.topK ?? DEFAULT_RECALL_TOP_K);
  const minConfidence = input.minConfidence ?? DEFAULT_RECALL_MIN_CONFIDENCE;

  if (!userId || !query) {
    return [];
  }

  try {
    const results = await searchLongTermMemories({
      query,
      minConfidence,
      pageSize: topK,
      userId,
    });

    return results.map((row) => ({
      content: row.content,
      score: row.finalScore,
    }));
  } catch {
    // Swallow — auto-recall is best-effort. The agent can still fall back
    // to the readMemory tool or the conversation summary.
    return [];
  }
}

/**
 * Format recalled memories into a single text block suitable for
 * injection as a system message. Returns null when there are no
 * memories to inject (caller should skip the system message entirely).
 */
export function formatRecalledMemoriesForContext(
  memories: RecalledMemory[],
): string | null {
  if (memories.length === 0) return null;

  const lines = memories.map((memory, index) => {
    return `${index + 1}. ${memory.content}`;
  });

  return [
    '[Relevant Long-term Memories]',
    "Auto-recalled from the user's stored long-term memory based on semantic relevance to their latest message. Use these as authoritative personal context — do NOT claim ignorance of facts listed here, and do NOT call readMemory to re-confirm them. If more detail is needed, call readMemory with a targeted query.",
    '',
    ...lines,
  ].join('\n');
}
