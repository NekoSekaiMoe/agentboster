/**
 * Generic Human-In-The-Loop (HITL) approval gate for workflow tools.
 *
 * Extracted from `lib/workflow/agent/tools/execute/sanbox.ts`
 * ::waitForSandboxApproval so ANY tool can opt into approval with a
 * single wrapper, mirroring AutoGPT's `Block.is_sensitive_action`
 * pattern (ref/.../backend/backend/blocks/_base.py
 * ::is_block_exec_need_review).
 *
 * Two ways to use it:
 *
 *  1. Wrap a tool's `execute` fn with `withSensitiveGate` — the gate
 *     checks `options.sensitive` + the session's autonomy level and
 *     either delegates to the wrapped execute, or awaits approval first.
 *
 *     ```ts
 *     execute: withSensitiveGate({ sensitive: true }, async (input) => { ... })
 *     ```
 *
 *  2. Call `waitForToolApproval` directly inside execute for custom
 *     pre-approval logic (e.g. only gate when the input matches a
 *     pattern). This is what sanbox.ts still does internally.
 *
 * Approval UX flows through the existing approval hook + the
 * `tool-approval-request` / `tool-output-denied` chunks, so the chat UI
 * already knows how to render the gate without changes.
 *
 * AutoGPT analogue: `Block.is_sensitive_action` + `sensitive_action_safe_mode`
 * on the execution context. Our autonomy level (`supervised`) is the
 * equivalent of `sensitive_action_safe_mode=true`.
 */

import { approvalHookBuilder } from '@/lib/workflow/agent/hooks';
import { sendApprovalRequestReminderStep } from '@/lib/workflow/agent/sender/bot-steps';
import {
  writeToolApprovalRequest,
  writeToolOutputDenied,
} from '@/lib/workflow/agent/sender/writers';
import type { AppConfig } from '@/types/config';
import type { ChatSource } from '@/types/workflow';

/**
 * Reason the gate decided to (not) require approval. Useful for logs and
 * for the `withSensitiveGate` caller that wants to know why a call was
 * allowed through without prompting.
 */
export type SensitiveGateDecision =
  | 'approved-proceed'
  | 'denied'
  | 'skipped-not-sensitive'
  | 'skipped-unsupervised';

/**
 * Wait for the user to approve / deny a tool call via the chat UI.
 *
 * This is the generic equivalent of sanbox.ts::waitForSandboxApproval.
 * Renamed so non-sandbox tools don't inherit a misleading name.
 *
 * Behavior:
 *  1. Emit a `tool-approval-request` chunk so the chat UI shows the
 *     approval card with the tool name + input.
 *  2. Block on the approval hook (resumed by the user's click).
 *  3. On deny, emit `tool-output-denied` and return approved=false.
 *
 * @returns `{ approved: boolean, comment?: string }`
 */
export async function waitForToolApproval(input: {
  sessionId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  /** Approval reminder UI is routed per source (web, IM adapter, ...). */
  source?: ChatSource;
}): Promise<{ approved: boolean; comment?: string }> {
  await writeToolApprovalRequest({
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    toolInput: input.toolInput,
  });

  await sendApprovalRequestReminderStep({
    source: input.source ?? { type: 'web' },
    toolCallId: input.toolCallId,
    toolName: input.toolName,
  });

  using hook = approvalHookBuilder.create({ token: input.toolCallId });

  // The hook yields once per resume; we only care about the first payload.
  // Default to denied if the hook ends without yielding (workflow cancelled).
  let approved = false;
  let comment: string | undefined;
  for await (const payload of hook) {
    approved = Boolean(payload.approved);
    comment = payload.comment;
    break;
  }

  if (!approved) {
    await writeToolOutputDenied({ toolCallId: input.toolCallId });
  }

  return { approved, comment };
}

/**
 * Decide whether a tool call needs the approval gate.
 *
 * A call needs approval when BOTH:
 *  - the tool declared itself sensitive (`options.sensitive === true`), AND
 *  - the session is in supervised autonomy mode.
 *
 * Either condition false → no gate. This matches the AutoGPT semantics:
 * `is_sensitive_action` on the block + `sensitive_action_safe_mode` on
 * the context must BOTH be true to trigger review.
 */
export function needsSensitiveApproval(input: {
  sensitive: boolean;
  appConfig: AppConfig;
}): boolean {
  return input.sensitive && input.appConfig.autonomy?.level === 'supervised';
}

/**
 * Wrap a tool `execute` function with the HITL approval gate.
 *
 * Usage:
 *
 * ```ts
 * export default defineBuildInTool({
 *   // ...
 *   factory: (config, ctx) => ({
 *     sendEmail: tool({
 *       // ...
 *       execute: withSensitiveGate(
 *         { sensitive: true, sessionId: ctx.sessionId, runId: ctx.runId },
 *         async (input) => { /* actually send the email *\/ },
 *       ),
 *     }),
 *   }),
 * });
 * ```
 *
 * When the gate is inactive (tool not sensitive OR autonomy not
 * supervised), the wrapper is zero-overhead: it calls the wrapped fn
 * immediately.
 */
export function withSensitiveGate<TInput, TResult>(
  options: {
    sensitive: boolean;
    sessionId: string;
    runId: string;
    source?: ChatSource;
    appConfig: AppConfig;
  },
  wrapped: (input: TInput, ctx: { toolCallId: string }) => Promise<TResult>,
): (input: TInput, ctx: { toolCallId: string }) => Promise<TResult | undefined> {
  return async (input, ctx) => {
    if (!needsSensitiveApproval({ sensitive: options.sensitive, appConfig: options.appConfig })) {
      return wrapped(input, ctx);
    }

    // The wrapper doesn't know the tool's own name at definition site —
    // the caller can bake it into toolInput display via the chat UI, but
    // the approval chunk carries toolCallId which is what the UI keys on.
    // We synthesize a toolName from the call site if the caller didn't
    // pass one; the real toolName is attached by the AI SDK to the
    // tool-input-available chunk emitted inside writeToolApprovalRequest.
    const decision = await waitForToolApproval({
      sessionId: options.sessionId,
      runId: options.runId,
      toolCallId: ctx.toolCallId,
      toolName: 'sensitive_tool',
      toolInput: input,
      source: options.source,
    });

    if (!decision.approved) {
      // Return undefined rather than throwing: the chat UI already showed
      // the denial via writeToolOutputDenied; throwing would surface as a
      // tool error and prompt the LLM to retry, which is not what we want.
      return undefined;
    }

    return wrapped(input, ctx);
  };
}
