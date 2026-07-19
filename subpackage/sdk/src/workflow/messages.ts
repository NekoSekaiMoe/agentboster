// Source: lib/chat/message-utils.ts:71-102
//
// Mirrors the DB-persisted message payload shape. The source file
// imports `WorkflowUIMessage` and several `ai`-package part types for
// its `parts` field; the SDK keeps `parts` as `unknown[]` to avoid the
// `ai` dependency, with a TODO for tightening later.

import type {
  ChatSource,
  PersistedMessageRole,
  WorkflowUIMessage,
} from './chunks.js';
import type { TokenUsage } from './types.js';

/**
 * The JSON payload column on a persisted message row.
 *
 * Source: lib/chat/message-utils.ts — `PersistedMessagePayload`.
 *
 * NOTE on `parts`:
 *   The source types this as `WorkflowUIMessage['parts']`, which is a
 *   deep discriminated union of AI-SDK part shapes. The SDK mirror of
 *   `WorkflowUIMessage` (see `./chunks.ts`) keeps `parts` structural —
 *   consumers that need full part narrowing should depend on `ai`
 *   directly.
 *
 * NOTE on `toolState` / `approval`:
 *   These mirror `DynamicToolUIPart['state']` and
 *   `DynamicToolUIPart['approval']` from the `ai` package, which the
 *   SDK does not vendor. Left as string-literal unions matching the
 *   runtime's `ai`-package defaults; widen if the runtime adopts new
 *   states.
 * TODO: tighten when ai-sdk types land as a real peer dep.
 */
export interface PersistedMessagePayload extends Record<string, unknown> {
  text?: string;
  parts?: WorkflowUIMessage['parts'];
  attachments?: unknown[];
  finishReason?: string | null;
  usage?: TokenUsage;
  toolCallId?: string;
  toolName?: string;
  toolState?:
    | 'input-available'
    | 'input-streaming'
    | 'output-available'
    | 'output-error'
    | (string & {});
  approval?: {
    state?: 'required' | 'allowed' | 'denied';
    reason?: string;
    [key: string]: unknown;
  };
  input?: unknown;
  output?: unknown;
  error?: string;
  source?: ChatSource;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

/**
 * The in-flight shape handed to the persistence layer before row
 * creation.
 *
 * Source: lib/chat/message-utils.ts — `SerializedMessageForDB`.
 */
export interface SerializedMessageForDB {
  sessionId: string;
  role: PersistedMessageRole;
  payload: PersistedMessagePayload;
  visibleInChat?: boolean;
  uiMessageId?: string | null;
  stepNumber?: number | null;
  createdAt?: Date;
}

/**
 * A `SerializedMessageForDB` after it has been written to the DB (i.e.
 * the row has a stable id and a concrete createdAt timestamp).
 *
 * Source: lib/chat/message-utils.ts — `PersistedMessageRecord`.
 */
export interface PersistedMessageRecord extends SerializedMessageForDB {
  id: string;
  createdAt: Date;
}
