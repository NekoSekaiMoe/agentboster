/**
 * Fire-and-forget POST→GET stream switch helper.
 *
 * POST /api/ai returns 202 { runId } and the actual SSE stream lives at
 * GET /api/ai/[runId]/stream. This helper detects a 202 response to a
 * POST and transparently reissues a GET against the stream endpoint,
 * returning that SSE response instead. Callers wire it at the top of
 * their DefaultChatTransport `fetch` wrapper.
 *
 * The workflow is durable and queue-driven; the GET endpoint reads the
 * run's stream from storage with startIndex:0, replaying every chunk
 * produced so far — so nothing is lost between the 202 and this GET.
 * Transparent to useChat: the Chat state machine just consumes the SSE
 * stream returned, regardless of whether it came from the POST or GET.
 *
 * Kept framework-agnostic (no React) so the transport construction
 * in components/chat/chat-container.tsx can use it without pulling
 * React into this module.
 */

import { ofetch } from 'ofetch';

export interface FireForgetResult {
  /** The response to hand back to the transport. Either the GET SSE
   *  response (when switched) or the original POST response. */
  response: Response;
  /** The runId extracted from the 202, if a switch happened. */
  runId: string | null;
}

/**
 * If `response` is a 202 to a POST with an `x-workflow-run-id` header,
 * reissue a GET to /api/ai/[runId]/stream and return that SSE response.
 * Otherwise return the original response untouched.
 */
export async function switchFireForgetPostToStream(
  response: Response,
  init: RequestInit | undefined,
): Promise<FireForgetResult> {
  if (
    response.status === 202 &&
    init?.method &&
    String(init.method).toUpperCase() === 'POST'
  ) {
    const runId = response.headers.get('x-workflow-run-id');
    if (runId) {
      const streamResponse = await ofetch.native(`/api/ai/${runId}/stream`, {
        method: 'GET',
        signal: init.signal,
      });
      return { response: streamResponse, runId };
    }
  }
  return { response, runId: null };
}
