/**
 * Near-duplicate detection for Dream memory operations.
 *
 * Inspired by AutoGPT's `dream/orchestrator.py::_near_duplicate` /
 * `_dedupe_near_duplicate_writes`, which uses word bigrams as a cheap
 * fingerprint to catch the same fact phrased slightly differently
 * before burning tokens / DB writes on it.
 *
 * Why bigrams (not embeddings) here:
 *  - Dream operations are already LLM output; we are filtering the model's
 *    own near-dup proposals, not doing semantic recall. Bigram Jaccard is
 *    O(n) and deterministic, with no embedding round-trip.
 *  - AutoGPT's pipeline uses exactly this trick at the same stage.
 *
 * The threshold (0.6) is calibrated for short factual sentences: below it,
 * two memories usually talk about different aspects; at or above it, one
 * is almost certainly a rephrasing of the other.
 */

const DEFAULT_THRESHOLD = 0.6;

/**
 * Tokenize content into lowercase word bigrams.
 *
 * - Collapses whitespace, strips punctuation.
 * - Single-word content returns an empty set (no bigrams) — callers treat
 *   empty fingerprints as "not duplicable" so a one-word fact never
 *   dedupes against anything.
 * - Stops at 200 bigrams so very long contents don't blow up the set;
 *   duplicates are almost always in the first sentence or two anyway.
 */
export function wordBigrams(content: string): Set<string> {
  const normalized = content
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return new Set();

  const words = normalized.split(' ');
  const bigrams = new Set<string>();
  const cap = Math.min(words.length - 1, 200);
  for (let i = 0; i < cap; i++) {
    bigrams.add(`${words[i]} ${words[i + 1]}`);
  }
  return bigrams;
}

/**
 * Jaccard similarity over the bigram sets.
 *
 * Returns 0 when either set is empty (AutoGPT's `_near_duplicate` returns
 * False in the same case — two contents with no parseable bigrams are
 * never treated as duplicates of each other).
 */
export function bigramSimilarity(a: string, b: string): number {
  const sa = wordBigrams(a);
  const sb = wordBigrams(b);
  if (sa.size === 0 || sb.size === 0) return 0;

  let intersection = 0;
  // Iterate the smaller set for speed.
  const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  for (const bg of small) {
    if (large.has(bg)) intersection += 1;
  }
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Decide whether two contents are near-duplicates.
 */
export function isNearDuplicate(
  a: string,
  b: string,
  threshold: number = DEFAULT_THRESHOLD,
): boolean {
  return bigramSimilarity(a, b) >= threshold;
}

/**
 * Deduplicate a list of proposed contents, keeping the first of each
 * near-duplicate cluster.
 *
 * Mirrors AutoGPT's `_dedupe_near_duplicate_writes`. O(n²) over the
 * accepted set — fine because Dream batches are small (≤ tens of
 * proposals per run). Each rejected item is returned with the id of
 * the accepted item it duplicates, so the caller can log the collapse.
 *
 * Optimization: each content's normalized bigram fingerprint is computed
 * ONCE up front and reused for every comparison, instead of re-tokenizing
 * both contents on every call to isNearDuplicate/bigramSimilarity.
 *
 * @returns `{ accepted, rejected }` where rejected[i] = { index, duplicateOf }
 */
export function dedupeNearDuplicateContents(input: {
  contents: string[];
  threshold?: number;
}): {
  accepted: number[];
  rejected: Array<{ index: number; duplicateOf: number }>;
} {
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const accepted: number[] = [];
  const rejected: Array<{ index: number; duplicateOf: number }> = [];
  // Precompute fingerprints for every content so the O(n²) loop below
  // compares pre-built Sets instead of re-tokenizing each side per pair.
  // Each fingerprint also remembers its size for the empty-set short-circuit.
  const fingerprints = input.contents.map((content) => {
    const bigrams = wordBigrams(content);
    return { bigrams, size: bigrams.size };
  });

  input.contents.forEach((_content, index) => {
    const here = fingerprints[index];
    // Empty fingerprint → never a duplicate (matches bigramSimilarity's
    // empty-set short-circuit). Accept without scanning.
    if (here.size === 0) {
      accepted.push(index);
      return;
    }
    const dupOf = accepted.find((accIdx) => {
      const other = fingerprints[accIdx];
      if (other.size === 0) return false;
      // Inline bigramSimilarity over the precomputed sets: iterate the
      // smaller set against the larger for speed.
      const [small, large] =
        here.size <= other.size ? [here, other] : [other, here];
      let intersection = 0;
      for (const bg of small.bigrams) {
        if (large.bigrams.has(bg)) intersection += 1;
      }
      const union = here.size + other.size - intersection;
      return union !== 0 && intersection / union >= threshold;
    });
    if (dupOf === undefined) {
      accepted.push(index);
    } else {
      rejected.push({ index, duplicateOf: dupOf });
    }
  });

  return { accepted, rejected };
}
