import { randomUUID } from 'node:crypto';
import { readSseStream, type UiMessageChunk } from '../../lib/sse';
import type { TuiHost } from '../tui';

/**
 * Chat controller. Owns sendMessage (POST /api/cli/chat + SSE drain)
 * and the live dispatching of local-tool-request chunks to the
 * LocalTools controller. Streaming text-delta appends into
 * `state.streamingText`; on stream completion the partial is flushed
 * into `state.turns`.
 */
export class ChatController {
  constructor(private readonly host: TuiHost) {}

  async sendMessage(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.host.state.phase.kind === 'streaming') return;
    if (!this.host.streamFetch || !this.host.state.deployment) {
      this.host.setStatus(this.host.theme.styles.error('Not logged in.'));
      return;
    }

    this.host.state.turns.push({
      id: randomUUID(),
      role: 'user',
      text: trimmed,
    });
    this.host.state.streamingText = '';
    this.host.state.phase = { kind: 'streaming' };
    this.host.setStatus(this.host.theme.styles.primary('thinking…'));
    this.host.render();

    const config = this.host.state.config;
    const fetcher = this.host.streamFetch;

    try {
      const response = await fetcher('/api/cli/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({
          id: this.host.state.sessionId,
          trigger: 'submit-message',
          input: { text: trimmed },
          clientId: config.clientId,
          label: config.label,
          ...(this.host.state.model ? { model: this.host.state.model } : {}),
        }),
      });

      if (!response.ok) {
        let errText = `${response.status} ${response.statusText}`;
        try {
          const body = (await response.json()) as {
            message?: string;
            error?: string;
          };
          errText = body.message ?? body.error ?? errText;
        } catch {
          // ignore
        }
        this.host.state.phase = { kind: 'error', message: errText };
        this.host.setStatus(this.host.theme.styles.error(`error: ${errText}`));
        this.host.render();
        return;
      }

      const runId = response.headers.get('x-workflow-run-id') ?? undefined;
      this.host.state.phase = { kind: 'streaming', runId };

      for await (const chunk of readSseStream(response)) {
        this.handleChunk(chunk);
      }

      // Flush streaming text into turns.
      if (this.host.state.streamingText) {
        this.host.state.turns.push({
          id: randomUUID(),
          role: 'assistant',
          text: this.host.state.streamingText,
        });
        this.host.state.streamingText = '';
      }
      this.host.state.phase = { kind: 'ready' };
      this.host.setStatus(this.host.theme.styles.textDim('ready'));
      this.host.render();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.host.state.phase = { kind: 'error', message: msg };
      this.host.setStatus(this.host.theme.styles.error(`error: ${msg}`));
      this.host.render();
    }
  }

  private handleChunk(chunk: UiMessageChunk): void {
    if (chunk.type === 'text-delta') {
      const delta = (chunk as { delta?: string }).delta;
      if (typeof delta === 'string') {
        this.host.state.streamingText += delta;
        this.host.render();
      }
      return;
    }

    if (chunk.type === 'error') {
      const text = (chunk as { errorText?: string }).errorText;
      if (text) {
        this.host.setStatus(
          this.host.theme.styles.error(`stream error: ${text}`),
        );
      }
      return;
    }

    if (chunk.type === 'data-workflow') {
      const data = (chunk as { data?: { kind: string; type: string } }).data;
      if (data?.kind === 'status' && data.type === 'local-tool-request') {
        const req = chunk as unknown as {
          data: {
            toolCallId: string;
            toolName: string;
            toolInput: unknown;
          };
        };
        // Fire-and-forget — keep draining the SSE stream.
        void this.host.localTools.executeRequest(req.data);
      }
    }
  }
}
