import type { CliConfig, CliDeployment } from '../lib/config';

/**
 * A single turn (user or assistant) in the visible transcript.
 */
export type Turn = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};

/**
 * Lifecycle state of the chat side of the TUI. The TUI coordinator
 * switches between these to decide what the transcript shows and
 * whether the editor accepts chat input.
 */
export type ChatPhase =
  | { kind: 'unauthenticated' }
  | { kind: 'ready' }
  | { kind: 'streaming'; runId?: string }
  | { kind: 'error'; message: string };

/**
 * Global TUI state. The coordinator owns one instance; controllers
 * receive it (or a reference to the coordinator) and mutate via
 * patch functions, never by direct field assignment from outside.
 */
export type TUIState = {
  config: CliConfig;
  /** Currently active deployment (null when unauthenticated). */
  deployment: { name: string; deployment: CliDeployment } | null;
  /** Session id the next POST /api/cli/chat will be sent against. */
  sessionId: string;
  /** Per-message model override (null = use server default). */
  model: string | null;
  /** Visible transcript (most recent last). */
  turns: Turn[];
  /** Partial assistant text while streaming; flushed to turns on completion. */
  streamingText: string;
  /** Chat lifecycle phase. */
  phase: ChatPhase;
  /** One-line status (already styled; rendered verbatim). Empty = hidden. */
  statusLine: string;
};

export function createInitialState(input: {
  config: CliConfig;
  deployment: { name: string; deployment: CliDeployment } | null;
  sessionId: string;
  model: string | null | undefined;
}): TUIState {
  return {
    config: input.config,
    deployment: input.deployment,
    sessionId: input.sessionId,
    model: input.model ?? null,
    turns: [],
    streamingText: '',
    phase: input.deployment ? { kind: 'ready' } : { kind: 'unauthenticated' },
    statusLine: '',
  };
}
