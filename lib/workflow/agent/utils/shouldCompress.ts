const COMPACTION_BUFFER = 20_000;
const DEFAULT_THRESHOLD = 0.8;

export function computeUsableContext(
  contextLimit: number,
  maxOutputTokens: number,
): number {
  if (contextLimit <= 0) return 0;
  const reserved = Math.min(COMPACTION_BUFFER, maxOutputTokens);
  return Math.max(0, contextLimit - reserved);
}

export function shouldCompress(
  totalTokensUsed: number,
  contextLimit: number | undefined,
  threshold = DEFAULT_THRESHOLD,
  force = false,
): boolean {
  if (force) return true;
  if (!contextLimit || contextLimit <= 0) return false;
  return totalTokensUsed >= contextLimit * threshold;
}

export function isContextOverflow(
  totalTokensUsed: number,
  contextLimit: number,
  maxOutputTokens: number,
): boolean {
  if (contextLimit <= 0) return false;
  const usable = computeUsableContext(contextLimit, maxOutputTokens);
  return usable > 0 && totalTokensUsed >= usable;
}

export interface CompactionDecision {
  shouldCompress: boolean;
  isOverflow: boolean;
  totalTokens: number;
  contextLimit: number;
  usableContext: number;
  usageRatio: number;
}

export function evaluateCompactionNeed(input: {
  totalTokensUsed: number;
  contextLimit: number;
  maxOutputTokens: number;
  threshold?: number;
  force?: boolean;
}): CompactionDecision {
  const usable = computeUsableContext(
    input.contextLimit,
    input.maxOutputTokens,
  );
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const force = input.force ?? false;

  const ratio =
    input.contextLimit > 0 ? input.totalTokensUsed / input.contextLimit : 0;

  const overflow = isContextOverflow(
    input.totalTokensUsed,
    input.contextLimit,
    input.maxOutputTokens,
  );

  const compress =
    force ||
    shouldCompress(
      input.totalTokensUsed,
      input.contextLimit,
      threshold,
      false,
    ) ||
    overflow;

  return {
    shouldCompress: compress,
    isOverflow: overflow,
    totalTokens: input.totalTokensUsed,
    contextLimit: input.contextLimit,
    usableContext: usable,
    usageRatio: ratio,
  };
}
