export function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.ceil(trimmed.length / 4);
}

type PromptMessage = {
  content: string | ReadonlyArray<unknown>;
};

export function estimatePromptTokens(
  messages: ReadonlyArray<PromptMessage>,
): number {
  return messages.reduce(
    (total, message) => total + estimatePromptMessageTokens(message.content),
    0,
  );
}

export function estimatePromptMessageTokens(
  content: PromptMessage['content'],
): number {
  if (typeof content === 'string') {
    return estimateTextTokens(content);
  }

  return content.reduce<number>((total, part) => {
    if (
      typeof part === 'object' &&
      part !== null &&
      'text' in part &&
      typeof part.text === 'string'
    ) {
      return total + estimateTextTokens(part.text);
    }
    return total;
  }, 0);
}

export function estimateMessageTokensFromUsage(
  usage:
    | { totalTokens?: number; inputTokens?: number; outputTokens?: number }
    | unknown,
): number {
  if (!usage || typeof usage !== 'object') return 0;
  const u = usage as {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  if (typeof u.totalTokens === 'number' && u.totalTokens > 0)
    return u.totalTokens;
  const input = typeof u.inputTokens === 'number' ? u.inputTokens : 0;
  const output = typeof u.outputTokens === 'number' ? u.outputTokens : 0;
  return input + output;
}
