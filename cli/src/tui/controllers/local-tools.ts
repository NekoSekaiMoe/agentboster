import { executeLocalTool } from '../../lib/local-tools';
import type { TuiHost } from '../tui';

/**
 * Local-tools controller. Receives `local-tool-request` payloads
 * emitted by the workflow (via the chat SSE stream), runs them
 * against the user's filesystem, and POSTs the result back to
 * /api/ai/[runId]/tool-result. The web side's
 * localToolResultHookBuilder.resume() unblocks the workflow agent
 * loop and the LLM continues.
 *
 * Calls are fire-and-forget from the chat controller's perspective —
 * the workflow naturally serializes because only one local_* tool is
 * in flight at a time (its execute body blocks the agent loop).
 */
export class LocalToolsController {
  constructor(private readonly host: TuiHost) {}

  async executeRequest(req: {
    toolCallId: string;
    toolName: string;
    toolInput: unknown;
  }): Promise<void> {
    const styles = this.host.theme.styles;
    this.host.setStatus(
      styles.textDim(`[local tool] ${req.toolName} — executing…`),
    );

    const result = await executeLocalTool(req.toolName, req.toolInput);

    this.host.setStatus(
      styles.textDim(
        `[local tool] ${req.toolName} — ${result.ok ? 'ok' : 'failed'}, posting…`,
      ),
    );

    const phase = this.host.state.phase;
    if (phase.kind !== 'streaming' || !phase.runId) {
      this.host.setStatus(
        styles.error(
          `[local tool] ${req.toolName} — no active runId; cannot post result`,
        ),
      );
      return;
    }
    if (!this.host.streamFetch) {
      this.host.setStatus(
        styles.error(`[local tool] ${req.toolName} — not logged in`),
      );
      return;
    }

    try {
      const res = await this.host.streamFetch(
        `/api/ai/${phase.runId}/tool-result`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            toolCallId: req.toolCallId,
            ok: result.ok,
            output: result.output,
            error: result.error,
          }),
        },
      );
      if (!res.ok) {
        const text = await res.text();
        this.host.setStatus(
          styles.error(
            `[local tool] ${req.toolName} — POST failed: ${res.status} ${text.slice(0, 200)}`,
          ),
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.host.setStatus(
        styles.error(`[local tool] ${req.toolName} — POST error: ${msg}`),
      );
    }
  }
}
