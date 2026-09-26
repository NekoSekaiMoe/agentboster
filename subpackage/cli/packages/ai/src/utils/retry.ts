import type { AssistantMessage } from '../types.ts';

function buildProviderErrorPattern(patterns: string[]): RegExp {
  return new RegExp(patterns.join('|'), 'i');
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
  // OpenCode Go/free-tier limits returned as 429 JSON error types by
  // OpenCode's Zen API. These are subscription/account limits, not
  // transient throttles.
  'GoUsageLimitError',
  'FreeUsageLimitError',
  'Monthly usage limit reached',
  'available balance',
  // Generic quota/budget/billing exhaustion. `insufficient_quota` is
  // OpenAI's quota/billing error code; the other strings cover common
  // gateway wording.
  'insufficient_quota',
  'out of budget',
  'quota exceeded',
  'billing',
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
  // Generic provider load, HTTP status, and server-side transient failures.
  'overloaded',
  'currently experiencing high demand',
  'rate.?limit',
  'too many requests',
  '429',
  '500',
  '502',
  '503',
  '504',
  '520',
  '524',
  'service.?unavailable',
  'server.?error',
  'internal.?error',
  // Wrapper/provider text for transient upstream failures.
  'provider.?returned.?error',
  'exceeded request buffer limit while retrying upstream',
  // Network, proxy, and fetch transport failures.
  'network.?error',
  'connection.?error',
  'connection.?refused',
  'connection.?lost',
  'other side closed',
  'fetch failed',
  'getaddrinfo',
  'ENOTFOUND',
  'EAI_AGAIN',
  'upstream.?connect',
  'reset before headers',
  'socket hang up',
  'socket connection was closed',
  'timed? out',
  'timeout',
  'terminated',
  // WebSocket transports can report close/error text instead of HTTP/fetch
  // text.
  'websocket.?closed',
  'websocket.?error',
  // Premature stream endings from SDKs and transports.
  'ended without',
  'stream ended before message_stop',
  'stream ended before a terminal response event',
  'http2 request did not get a response',
  // Provider-requested retry delay cap failures.
  'retry delay',
  // Explicit retry guidance emitted mid-stream by provider stream
  // exceptions.
  'you can retry your request',
  'try your request again',
  'please retry your request',
  // gRPC based providers (e.g. NVIDIA NIM)
  'ResourceExhausted',
]);

/** Default cap on agent-level retry backoff (pi #8826). */
export const DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60_000;

/**
 * Return exponential retry backoff in milliseconds, capped by maxAgentDelayMs
 * (60,000 by default). Attempt 1 and lower use the base delay. A computed
 * delay that is not a safe integer uses Number.MAX_SAFE_INTEGER before capping.
 */
export function retryDelayMs(
  policy: { baseDelayMs: number; maxAgentDelayMs?: number },
  attempt: number,
): number {
  const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const safeDelay = Number.isSafeInteger(delay)
    ? delay
    : Number.MAX_SAFE_INTEGER;
  return Math.min(
    safeDelay,
    policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
  );
}

/**
 * Classifies whether a failed assistant message looks like a transient
 * provider or transport error, so callers can decide if the last assistant
 * turn should be restarted. Ported from pi-ai 0.87.1 (`utils/retry.ts`).
 * Requires an error stop with nonempty error text; recognized account, quota,
 * and billing limits take precedence over transient-error matches.
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
  if (message.stopReason !== 'error' || !message.errorMessage) return false;
  const errorMessage = message.errorMessage;
  if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) {
    return false;
  }
  return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}
