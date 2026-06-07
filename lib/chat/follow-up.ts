const MAX_FOLLOW_UP_CONTEXT_CHARS = 4096;

function truncateContext(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_FOLLOW_UP_CONTEXT_CHARS) {
    return trimmed;
  }

  return `${trimmed.slice(0, MAX_FOLLOW_UP_CONTEXT_CHARS)}\n...[truncated]`;
}

export function buildInlineFollowUpText(input: {
  question: string;
  quoteText: string;
  quoteLabel?: string;
}): string {
  const quoteLabel = input.quoteLabel?.trim() || '引用内容';
  const quoteText = truncateContext(input.quoteText);
  const question = input.question.trim();

  return [
    '请在当前会话内回答下面的追问，不要创建新任务。回答时优先聚焦引用内容，必要时结合当前会话上下文。',
    '',
    `【${quoteLabel}】`,
    quoteText,
    '',
    '【追问】',
    question || '请展开说明这段内容。',
  ].join('\n');
}
