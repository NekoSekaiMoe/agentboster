export function executeIdCommand(input: {
  sessionId: string | null;
  userId: string | null;
  source: { adapter?: string; threadId?: string } | null;
}): { text: string } {
  const lines = ['当前 ID 信息：'];

  if (input.sessionId) {
    lines.push(`Session ID: ${input.sessionId}`);
  } else {
    lines.push('Session ID: (无)');
  }

  if (input.userId) {
    lines.push(`User ID: ${input.userId}`);
  }

  if (input.source?.adapter) {
    lines.push(`Adapter: ${input.source.adapter}`);
  }

  if (input.source?.threadId) {
    lines.push(`Thread ID: ${input.source.threadId}`);
  }

  return { text: lines.join('\n') };
}
