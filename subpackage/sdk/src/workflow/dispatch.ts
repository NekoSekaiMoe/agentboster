// Source: lib/workflow/agent/dispatch.ts
//
// Facade interface only — the SDK does NOT port the dispatch
// implementations. They are runtime-bound (drizzle, workflow/api,
// after-response draining, etc.) and live in the Web tier. Only the
// public function signatures' input/output shapes are mirrored here so
// external consumers (test harnesses, third-party dispatchers) can
// type-check against the dispatch contract.
//
// All references to runtime-only types (Run, ReadableStream
// constructed by `workflow/api`, AppConfig, ClientSpoof, ModelMessage)
// are kept structural or `unknown` to keep the SDK self-contained.

import type {
  ChatHookPayload,
  ChatSource,
  ToolApprovalPayload,
  WorkflowUIMessageChunk,
} from './chunks.js';
import type { LocalToolResultHookPayload } from './hooks.js';

/**
 * Input shape for `startWorkflow`.
 *
 * Source: lib/workflow/agent/dispatch.ts — `startWorkflow` (input arg).
 *
 * NOTE:
 *   - `initialMessages` mirrors `ModelMessage[]` from `ai`. Left as
 *     `unknown[]` — consumers passing real model messages can cast.
 *   - `config` mirrors `AppConfig` from `@/types/config`. Left as
 *     `unknown`.
 *   - `clientSpoof` mirrors `ClientSpoof` from `@/types/config/ai`.
 *     Left as `unknown`.
 * TODO: tighten when the config surface lands in the SDK.
 */
export interface StartWorkflowInput {
  sessionId: string;
  initialMessages: unknown[];
  config: unknown;
  source: ChatSource;
  user?: {
    modelPreferences?: { model?: string } | null;
  } | null;
  /**
   * Per-message model override from the chat-box picker.
   */
  requestModel?: string | null;
  /**
   * Merged AGENTS.md content forwarded by the CLI host and persisted
   * on session.metadata.
   */
  agentsMd?: string;
  /**
   * Plan mode toggle from the CLI `/plan` command. Filters the toolset
   * to read-only / observe / reason tools only.
   */
  planMode?: boolean;
  /**
   * Thinking level from the CLI `/effort` command.
   */
  thinkingLevel?: string;
  /**
   * Experimental client-spoof profile from CLI/Desktop settings.
   */
  clientSpoof?: unknown;
}

/**
 * Output shape of `startWorkflow`.
 *
 * Source: lib/workflow/agent/dispatch.ts — `startWorkflow` (return).
 *
 * NOTE: `readable` mirrors the `ReadableStream<WorkflowUIMessageChunk>`
 * returned by the runtime. The chunk type is mirrored in
 * `./chunks.ts`; the stream itself is the platform `ReadableStream`
 * generic and is re-typed here for ergonomics.
 */
export interface StartWorkflowOutput {
  runId: string;
  readable: ReadableStream<WorkflowUIMessageChunk>;
}

/**
 * Facade type for the runtime's `startWorkflow` function.
 *
 * Source: lib/workflow/agent/dispatch.ts — `startWorkflow`.
 *
 * The SDK declares only the signature; the host injects the real
 * implementation at load time. External callers that want to mock the
 * dispatcher in tests can implement this signature.
 */
export type StartWorkflow = (
  input: StartWorkflowInput,
) => Promise<StartWorkflowOutput>;

/**
 * Payload for resuming a workflow run with a new user / system / control
 * message. Mirrors `resumeWithMessage`'s second parameter.
 *
 * Source: lib/workflow/agent/dispatch.ts — `resumeWithMessage`.
 */
export type ResumeWithMessagePayload = ChatHookPayload;

/**
 * Facade for `resumeWithMessage`.
 *
 * Source: lib/workflow/agent/dispatch.ts — `resumeWithMessage`.
 */
export type ResumeWithMessage = (
  runId: string,
  payload: ResumeWithMessagePayload,
) => Promise<void>;

/**
 * Payload for the tool-approval resume path. Mirrors
 * `resumeToolApproval`'s second parameter (typed against the umbrella
 * `ToolApprovalPayload` from `types/workflow.ts`, which adds
 * `toolCallId` vs the approvalHook-local schema).
 *
 * Source: lib/workflow/agent/dispatch.ts — `resumeToolApproval`.
 */
export type ResumeToolApprovalPayload = ToolApprovalPayload;

/**
 * Facade for `resumeToolApproval`.
 *
 * Source: lib/workflow/agent/dispatch.ts — `resumeToolApproval`.
 */
export type ResumeToolApproval = (
  toolCallId: string,
  payload: ResumeToolApprovalPayload,
) => Promise<void>;

/**
 * Payload for the local-tool-result resume path. Mirrors
 * `resumeLocalToolResult`'s inline second parameter.
 *
 * Source: lib/workflow/agent/dispatch.ts — `resumeLocalToolResult`.
 */
export type ResumeLocalToolResultPayload = LocalToolResultHookPayload;

/**
 * Facade for `resumeLocalToolResult`.
 *
 * Source: lib/workflow/agent/dispatch.ts — `resumeLocalToolResult`.
 */
export type ResumeLocalToolResult = (
  toolCallId: string,
  payload: ResumeLocalToolResultPayload,
) => Promise<void>;
