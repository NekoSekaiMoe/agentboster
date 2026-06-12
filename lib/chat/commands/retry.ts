export async function executeRetryCommand(input: {
  sessionId: string | null;
}): Promise<{ shouldRetry: boolean; text?: string }> {
  if (!input.sessionId) {
    return { shouldRetry: false, text: '没有活动的会话。' };
  }

  // Signal that we should regenerate the last response
  // The actual retry will be handled by the chatMain flow
  return { shouldRetry: true };
}
