/**
 * Minimal SSE reader for the /api/cli/chat + /api/ai/[runId]/stream
 * responses. The web returns a UIMessageStream (Vercel AI SDK) —
 * `data: <json>\n\n` frames. We parse each frame and yield the chunk.
 *
 * This deliberately does NOT use @ai-sdk/react (browser-only). We only
 * need the raw chunks: text-delta for assistant tokens, data-workflow
 * for status events (including local-tool-request), and the standard
 * tool-* chunks for tool calls.
 */
export type UiMessageChunk = {
  type: string;
  [key: string]: unknown;
};

export async function* readSseStream(
  response: Response,
): AsyncGenerator<UiMessageChunk> {
  if (!response.body) {
    throw new Error('Response has no body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by \n\n. Process complete frames.
      let frameEnd = buffer.indexOf('\n\n');
      while (frameEnd !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);

        const chunk = parseSseFrame(frame);
        if (chunk) {
          yield chunk;
        }

        frameEnd = buffer.indexOf('\n\n');
      }
    }

    // Flush any trailing frame (some endpoints don't terminate with \n\n).
    const remaining = buffer.trim();
    if (remaining) {
      const chunk = parseSseFrame(remaining);
      if (chunk) yield chunk;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseFrame(frame: string): UiMessageChunk | null {
  // A frame is a series of lines. We care about `data:` lines.
  // Multiple data lines concatenate into one payload (SSE spec).
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      dataLines.push(trimmed.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const raw = dataLines.join('\n');
  if (raw === '[DONE]') {
    return { type: 'done' };
  }

  try {
    return JSON.parse(raw) as UiMessageChunk;
  } catch {
    return null;
  }
}
