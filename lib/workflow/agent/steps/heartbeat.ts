/**
 * Heartbeat run helpers — the workflow-side half of the session heartbeat
 * (see .agents/notes/implemented/feature/2026-09-13-session-heartbeat.md).
 *
 * deliver/record are module-level 'use step' functions (KV/HTTP/DB are
 * host-only; the DevKit bundler must not see them as static workflow-bundle
 * deps). The extractors are pure and run inline.
 */
import type { ChatSource } from '@/types/workflow';
import type { ModelMessage } from 'ai';
import { HEARTBEAT_DECISION_TOOL_NAME } from '../tools/heartbeat/decision';

/** Send the composed proactive reply to the session's IM thread. */
export async function deliverHeartbeatReplyStep(input: {
  source: ChatSource;
  text: string;
}): Promise<boolean> {
  'use step';

  const { sendAdapterSourceReply } = await import('@/lib/bot/reply');
  return sendAdapterSourceReply(input.source, input.text);
}

/** Persist the heartbeat outcome on session_heartbeats. */
export async function recordHeartbeatOutcomeStep(input: {
  sessionId: string;
  reply: boolean;
  chatRunId: string | null;
  failed?: boolean;
}): Promise<void> {
  'use step';

  const { recordHeartbeatResult } = await import('@/lib/core/db/heartbeat');
  await recordHeartbeatResult(input);
}

export interface HeartbeatDecision {
  reply: boolean;
  reason?: string;
}

/**
 * Extract the heartbeat_decision outcome from a run's steps. The decision
 * is the tool-call INPUT (single source of truth — the executor only
 * acknowledges). Returns null when the model never called the tool
 * (callers treat that as fail-closed silence).
 */
export function extractHeartbeatDecision(
  steps: ReadonlyArray<{
    toolCalls?: ReadonlyArray<{
      toolName: string;
      input?: unknown;
    }>;
  }>,
): HeartbeatDecision | null {
  for (const step of steps) {
    for (const call of step.toolCalls ?? []) {
      if (call.toolName !== HEARTBEAT_DECISION_TOOL_NAME) continue;
      const input = call.input as
        | { reply?: unknown; reason?: unknown }
        | undefined;
      if (input && typeof input.reply === 'boolean') {
        return {
          reply: input.reply,
          reason: typeof input.reason === 'string' ? input.reason : undefined,
        };
      }
    }
  }
  return null;
}

/** The final assistant text of a run (the proactive message to deliver). */
export function extractFinalAssistantText(
  messages: ReadonlyArray<ModelMessage>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    const content =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .flatMap((part) =>
              part.type === 'text' && typeof part.text === 'string'
                ? [part.text]
                : [],
            )
            .join('');
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}
