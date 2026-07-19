// Source: lib/workflow/agent/hooks/{approvalHook,instructionHook,localToolHook,types}.ts
//
// Mirrors the workflow's three hook-builder payload schemas and the
// application-layer lifecycle-hook system. The original modules
// declare zod schemas on top of `defineHook` from `workflow`; the SDK
// only needs the contract types, so each schema is translated to a TS
// type and pointed back at its source file.

import type { MessagePart } from './chunks.js';

// ── Hook-builder payloads ──────────────────────────────────────────

/**
 * Payload schema for the tool-approval hook.
 *
 * Source: lib/workflow/agent/hooks/approvalHook.ts —
 *        `toolApprovalPayloadSchema`.
 *
 * NOTE: the standalone approvalHook.ts schema does NOT include
 * `toolCallId` (which the umbrella `types/workflow.ts`
 * `toolApprovalPayloadSchema` adds). Mirror what this source file
 * actually declares — do not collapse the two.
 */
export interface ToolApprovalHookPayload {
  approved: boolean;
  comment?: string;
}

/**
 * Discriminated-union payload for the instruction hook. Mirrors
 * `instructionHookSchema`.
 *
 * Source: lib/workflow/agent/hooks/instructionHook.ts —
 *        `instructionHookSchema`.
 */
export type InstructionHookPayload =
  | {
      type: 'user';
      message: string;
      parts?: MessagePart[];
      uiMessageId?: string;
    }
  | {
      type: 'system';
      message: string;
    }
  | {
      type: 'control';
      command: 'compact' | 'cancel';
      reason?: string;
    };

/**
 * Payload schema for the local-tool-result hook.
 *
 * Source: lib/workflow/agent/hooks/localToolHook.ts —
 *        `localToolResultPayloadSchema`.
 */
export interface LocalToolResultHookPayload {
  ok: boolean;
  output?: unknown;
  error?: string;
}

// ── Application-layer lifecycle hooks ──────────────────────────────
//
// These are independent of `@workflow/core`. They describe the
// in-process hook registry the host runs alongside the workflow DevKit
// (before/after tool call, before message persist, etc.).
//
// Source: lib/workflow/agent/hooks/types.ts

/**
 * The lifecycle nodes the application hook registry can attach to.
 *
 * Source: lib/workflow/agent/hooks/types.ts — `HookNode`.
 */
export type HookNode =
  | 'beforeWorkflowStart'
  | 'afterWorkflowEnd'
  | 'beforeToolCall'
  | 'afterToolCall'
  | 'beforeMessagePersist'
  | 'afterStepFinish'
  | 'onError';

/**
 * Per-invocation context handed to every registered hook handler.
 *
 * Source: lib/workflow/agent/hooks/types.ts — `HookContext`.
 *
 * NOTE: `appConfig` mirrors `AppConfig` from `@/types/config`. That
 * type is a large zod-inferred config root and is out of scope for the
 * workflow surface — left as `unknown` here.
 * TODO: tighten when the config surface lands in the SDK.
 */
export interface HookContext {
  sessionId: string;
  runId: string;
  agentName: string;
  appConfig: unknown;
}

/**
 * Source: lib/workflow/agent/hooks/types.ts — `BeforeToolCallPayload`.
 */
export interface BeforeToolCallPayload {
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
}

/**
 * Source: lib/workflow/agent/hooks/types.ts — `AfterToolCallPayload`.
 */
export interface AfterToolCallPayload extends BeforeToolCallPayload {
  result: unknown;
  error?: Error;
  elapsedMs: number;
}

/**
 * Source: lib/workflow/agent/hooks/types.ts — `BeforeMessagePersistPayload`.
 *
 * NOTE: `message` mirrors `SerializedMessageForDB` from
 * `@/lib/chat/message-utils`. That interface is mirrored in
 * `./messages.ts` and re-imported there to avoid the `@/lib` alias; we
 * keep it `unknown` here to dodge a circular reference (messages.ts
 * imports from chunks.ts which re-imports fine, but hooks.ts →
 * messages.ts → chunks.ts → ... would still be acyclic — preferring the
 * explicit cross-surface type from `./messages.ts`).
 */
export interface BeforeMessagePersistPayload {
  message: unknown;
}

/**
 * Source: lib/workflow/agent/hooks/types.ts — `AfterStepFinishPayload`.
 *
 * NOTE: `step` mirrors `StepResult<ToolSet>` from the `ai` package; the
 * SDK does not depend on `ai` so the structural shape from
 * `./types.ts`'s aggregateTokenUsage argument is reused implicitly.
 * TODO: tighten when ai-sdk types land as a real peer dep.
 */
export interface AfterStepFinishPayload {
  step: {
    usage?: {
      inputTokens?: unknown;
      outputTokens?: unknown;
      totalTokens?: number;
    };
    [key: string]: unknown;
  };
  usage: import('./types.js').TokenUsage;
}

/**
 * Source: lib/workflow/agent/hooks/types.ts — `BeforeWorkflowStartPayload`.
 */
export interface BeforeWorkflowStartPayload {
  sessionId: string;
  source: unknown;
  initialMessages: unknown[];
}

/**
 * Source: lib/workflow/agent/hooks/types.ts — `AfterWorkflowEndPayload`.
 */
export interface AfterWorkflowEndPayload {
  sessionId: string;
  status: 'completed' | 'error' | 'cancelled';
  error?: string;
  totalTokens: number;
}

/**
 * Source: lib/workflow/agent/hooks/types.ts — `OnErrorPayload`.
 */
export interface OnErrorPayload {
  error: Error;
  phase: 'tool' | 'workflow' | 'message';
  context: Record<string, unknown>;
}

/**
 * Maps each {@link HookNode} to its concrete payload type.
 *
 * Source: lib/workflow/agent/hooks/types.ts — `HookPayloads`.
 */
export interface HookPayloads {
  beforeWorkflowStart: BeforeWorkflowStartPayload;
  afterWorkflowEnd: AfterWorkflowEndPayload;
  beforeToolCall: BeforeToolCallPayload;
  afterToolCall: AfterToolCallPayload;
  beforeMessagePersist: BeforeMessagePersistPayload;
  afterStepFinish: AfterStepFinishPayload;
  onError: OnErrorPayload;
}

/**
 * Handler signature for a lifecycle hook. Returning `undefined` is
 * equivalent to "no-op"; returning a (possibly mutated) payload
 * forwards it to the next handler.
 *
 * Source: lib/workflow/agent/hooks/types.ts — `HookHandler<T>`.
 */
export type HookHandler<T> = (
  payload: T,
  context: HookContext,
) => T | undefined | Promise<T | undefined>;

/**
 * A registered hook entry in the application-layer registry.
 *
 * Source: lib/workflow/agent/hooks/types.ts — `HookRegistration<T>`.
 */
export interface HookRegistration<T = unknown> {
  node: HookNode;
  handler: HookHandler<T>;
  priority: number;
  id: string;
}
