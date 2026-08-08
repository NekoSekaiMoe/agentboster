/**
 * Canonical task failure taxonomy.
 *
 * Ported from Multica's `ref/server/pkg/taskfailure` package (22 canonical
 * values + Classify() regex classifier). Until this module existed,
 * agentboster's `agent_tasks.result` was free-text — failures were
 * unclassifiable at scale, smart-retry impossible, and failure dashboards
 * meaningless.
 *
 * The 22 values fall into two groups:
 *
 *   - 8 platform-side values (no `agent_error.` prefix) — failure
 *     attributable to the platform/scheduler/runtime layer rather than the
 *     agent process: queued_expired, runtime_offline, runtime_recovery,
 *     timeout, iteration_limit, agent_blocked, api_invalid_request,
 *     skill_bundle_unavailable.
 *
 *   - 14 agent-side values (`agent_error.` prefix) — produced by
 *     {@link classifyFailure} when the agent process surfaced an error
 *     string. {@link isAgentError} reports membership in this set.
 *
 * Wire stability: the string forms of these constants are persisted into
 * the database (`agent_tasks.failure_reason`) and surfaced as dashboard
 * labels. Renaming is a breaking change. New values may be added.
 */

/** Marker prefix for agent-process sub-reasons. */
export const AGENT_ERROR_PREFIX = 'agent_error.';

/**
 * The canonical Reason values. Mirrors Multica's `Reason*` constants
 * in `ref/server/pkg/taskfailure/failure.go`.
 */
export const FAILURE_REASON = {
  // ── Platform / scheduler side ───────────────────────────────────────
  /** Task sat in 'pending' past the TTL without being claimed. */
  QUEUED_EXPIRED: 'queued_expired',
  /** The daemon owning a running task went offline. */
  RUNTIME_OFFLINE: 'runtime_offline',
  /** Daemon restarted mid-flight; prior session unrecoverable. */
  RUNTIME_RECOVERY: 'runtime_recovery',
  /** Server-side or runtime-side hard timeout. */
  TIMEOUT: 'timeout',
  /** Agent reached its per-run iteration cap. */
  ITERATION_LIMIT: 'iteration_limit',
  /** Agent intentionally entered 'blocked' (e.g. requesting human input). */
  AGENT_BLOCKED: 'agent_blocked',
  /** Upstream LLM API rejected the request body (400 invalid_request_error). */
  API_INVALID_REQUEST: 'api_invalid_request',
  /** Daemon could not download the agent's skill bundles. */
  SKILL_BUNDLE_UNAVAILABLE: 'skill_bundle_unavailable',

  // ── Agent process side (agent_error.*) ──────────────────────────────
  /** 401 / 403 / not logged in / invalid API key / no model access. */
  AGENT_PROVIDER_AUTH_OR_ACCESS: 'agent_error.provider_auth_or_access',
  /** 402 / insufficient balance / monthly usage limit / credits exhausted. */
  AGENT_PROVIDER_QUOTA_LIMIT: 'agent_error.provider_quota_limit',
  /** 429 / 529 / overloaded / rate limit. Retryable. */
  AGENT_PROVIDER_CAPACITY_OR_RATE_LIMIT:
    'agent_error.provider_capacity_or_rate_limit',
  /** Provider 5xx / internal error / bad gateway. Retryable. */
  AGENT_PROVIDER_SERVER_ERROR: 'agent_error.provider_server_error',
  /** Stream cut / dial failure / DNS or I/O timeout. Retryable. */
  AGENT_PROVIDER_NETWORK: 'agent_error.provider_network',
  /** Context length / token window overflow. NOT retryable. */
  AGENT_CONTEXT_OVERFLOW: 'agent_error.context_overflow',
  /** Missing API key / no provider configured. */
  AGENT_MISSING_CONFIG: 'agent_error.missing_config',
  /** Agent process crashed / non-zero exit / OOM. */
  AGENT_PROCESS_FAILURE: 'agent_error.process_failure',
  /** Agent said "I can't" / refuse-to-act / policy violation. */
  AGENT_REFUSAL: 'agent_error.refusal',
  /** Conversation history poisoned (unresumable). */
  AGENT_POISONED_HISTORY: 'agent_error.poisoned_history',
  /** Sub-agent / delegation chain failure. */
  AGENT_SUBAGENT_FAILURE: 'agent_error.subagent_failure',
  /** Tool invocation failed (sandboxed exec, file, browser). */
  AGENT_TOOL_FAILURE: 'agent_error.tool_failure',
  /** LLM returned a structurally invalid response (bad JSON, etc.). */
  AGENT_INVALID_RESPONSE: 'agent_error.invalid_response',
  /** Catchall when no rule matches. */
  AGENT_UNKNOWN: 'agent_error.unknown',
} as const;

export type FailureReason =
  (typeof FAILURE_REASON)[keyof typeof FAILURE_REASON];

/** All 22 canonical values. Useful for dashboard label pre-warming. */
export const ALL_FAILURE_REASONS: readonly FailureReason[] =
  Object.values(FAILURE_REASON);

/** True if the reason originates inside the agent process (14 of 22). */
export function isAgentError(reason: string | null | undefined): boolean {
  // Boolean() narrowing does not propagate into startsWith under strict
  // mode; guard explicitly.
  if (!reason) return false;
  return reason.startsWith(AGENT_ERROR_PREFIX);
}

/**
 * Reasons on the retry allowlist. Only these auto-retry — everything else
 * is either non-transient (auth, quota, context overflow) or structurally
 * not retryable (agent_blocked, agent_refusal). Mirrors Multica's
 * `retryableReasons` in `server/internal/service/task.go`.
 *
 * `skill_bundle_unavailable` is retryable + cheap: bundles that arrived
 * before the cut are cached on disk, so successive attempts converge.
 */
export const RETRYABLE_REASONS: ReadonlySet<FailureReason> = new Set([
  FAILURE_REASON.AGENT_PROVIDER_NETWORK,
  FAILURE_REASON.AGENT_PROVIDER_CAPACITY_OR_RATE_LIMIT,
  FAILURE_REASON.AGENT_PROVIDER_SERVER_ERROR,
  FAILURE_REASON.SKILL_BUNDLE_UNAVAILABLE,
]);

export function isRetryable(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return (RETRYABLE_REASONS as Set<string>).has(reason);
}

// ── Classify ─────────────────────────────────────────────────────────

/**
 * Digit-boundary guards so status-code substrings don't fire on unrelated
 * numbers ("402913 tokens", "15290ms", "exit status 4030"). Mirrors
 * Multica's `providerHTTP5xxRe` / `httpAuthCodeRe` / etc. in classify.go.
 */
const HTTP_5XX_RE = /(^|[^0-9])5[0-9][0-9]([^0-9]|$)/;
const HTTP_AUTH_RE = /(^|[^0-9])(401|403)([^0-9]|$)/;
const HTTP_QUOTA_RE = /(^|[^0-9])402([^0-9]|$)/;
const HTTP_CAPACITY_RE = /(^|[^0-9])(429|529)([^0-9]|$)/;

function containsAny(haystack: string, ...needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

function containsAll(haystack: string, ...needles: string[]): boolean {
  return needles.every((n) => haystack.includes(n));
}

/**
 * Map a free-form error string from the agent runtime to one of the 14
 * agent_error.* sub-reasons. Always returns a valid {@link FailureReason};
 * falls back to {@link FAILURE_REASON.AGENT_UNKNOWN} for empty input.
 *
 * Matching is case-insensitive substring against the lowercased input.
 * Rule order matters — more-specific rules precede more-generic ones
 * (e.g. context_overflow before quota_limit, since "token limit" would
 * otherwise be claimed by quota via "limit").
 *
 * Ported from Multica's `Classify()` in classify.go. When the two diverge,
 * Multica's classifier is the source of truth; update this to match.
 */
export function classifyFailure(
  rawError: string | null | undefined,
): FailureReason {
  const trimmed = (rawError ?? '').trim();
  if (!trimmed) return FAILURE_REASON.AGENT_UNKNOWN;
  const lower = trimmed.toLowerCase();

  // 1. Context / token window overflow (early so "token limit" isn't swallowed by quota).
  if (
    containsAny(
      lower,
      'context length',
      'context_length_exceeded',
      'maximum context',
      'prompt is too long',
      'context size has been exceeded',
      // Claude Code 2.1.x response-side overflow (stop_reason
      // model_context_window_exceeded). These carry neither 'token' nor
      // 'limit', so without them the failure falls through to unknown —
      // and the over-full session stays pinned as the resume pointer,
      // replaying the overflow forever. Ported from Multica classify.go
      // contextWindowExceededWitnesses.
      'context window limit',
      'model_context_window_exceeded',
      'prompt_too_long',
    ) ||
    containsAll(lower, 'token', 'limit')
  ) {
    return FAILURE_REASON.AGENT_CONTEXT_OVERFLOW;
  }

  // 2. Missing config / API key (before auth — "missing api key" overlaps wording).
  if (
    containsAny(lower, 'missing environment variable') ||
    containsAll(lower, 'missing', 'api_key') ||
    containsAll(lower, 'api key', 'required') ||
    containsAny(lower, 'no llm provider configured', 'no provider configured')
  ) {
    return FAILURE_REASON.AGENT_MISSING_CONFIG;
  }

  // 3. Auth / access.
  if (
    HTTP_AUTH_RE.test(lower) ||
    containsAny(
      lower,
      'unauthorized',
      'login required',
      'not logged in',
      'please login again',
      'refresh token',
      'invalid api key',
      'access token',
      'subscription access',
      'does not have access',
      'you may not have access',
    )
  ) {
    return FAILURE_REASON.AGENT_PROVIDER_AUTH_OR_ACCESS;
  }

  // 4. Quota / billing.
  if (
    HTTP_QUOTA_RE.test(lower) ||
    containsAny(
      lower,
      'insufficient_balance',
      'balance is too low',
      'monthly usage limit',
      'usage limit',
      "you've hit your limit",
      'you\u2019ve hit your limit',
      'credits',
      'quota',
    )
  ) {
    return FAILURE_REASON.AGENT_PROVIDER_QUOTA_LIMIT;
  }

  // 5. Capacity / rate limit.
  if (
    HTTP_CAPACITY_RE.test(lower) ||
    containsAny(lower, 'rate limit', 'overloaded', 'no capacity available')
  ) {
    return FAILURE_REASON.AGENT_PROVIDER_CAPACITY_OR_RATE_LIMIT;
  }

  // 6. Provider 5xx / server error.
  if (
    containsAny(
      lower,
      'server had an error',
      'provider returned error',
      'internal error',
      'service unavailable',
      'bad gateway',
    ) ||
    HTTP_5XX_RE.test(lower)
  ) {
    return FAILURE_REASON.AGENT_PROVIDER_SERVER_ERROR;
  }

  // 7. Provider network (stream cut / dial failure / I/O timeout). Retryable.
  if (
    containsAny(
      lower,
      'stream disconnected',
      'connection closed',
      'mid-response',
      'error sending request',
      'unable to connect',
      'deadline exceeded',
      'no such host',
      'connection reset',
      'connection refused',
      'i/o timeout',
      'econnreset',
      'econnrefused',
      'etimedout',
    )
  ) {
    return FAILURE_REASON.AGENT_PROVIDER_NETWORK;
  }

  // 8. Process failure (non-zero exit / OOM / killed).
  if (
    containsAny(
      lower,
      'exit status',
      'process killed',
      'out of memory',
      'signal: killed',
      'oom',
    )
  ) {
    return FAILURE_REASON.AGENT_PROCESS_FAILURE;
  }

  // 9. Refusal / policy violation.
  if (
    containsAny(
      lower,
      "i can't help",
      'i cannot help',
      'policy violation',
      'content policy',
      'safety',
    )
  ) {
    return FAILURE_REASON.AGENT_REFUSAL;
  }

  // 10. Tool failure.
  if (
    containsAny(
      lower,
      'tool failed',
      'tool execution',
      'sandbox',
      'exec failed',
    )
  ) {
    return FAILURE_REASON.AGENT_TOOL_FAILURE;
  }

  // 11. Invalid LLM response.
  if (containsAny(lower, 'invalid json', 'parse error', 'malformed response')) {
    return FAILURE_REASON.AGENT_INVALID_RESPONSE;
  }

  // TODO(tech-debt): Multica classify.go carries 5 more rules between
  // network(7) and process_failure(13) that this port omits — see
  // ref/server/pkg/taskfailure/classify.go rules 8-12:
  //   - model_not_found / model_not_available
  //   - empty_output (agent produced no text)
  //   - timeout-as-text ("timed out after N") — distinct from
  //     network(7)'s "deadline exceeded" Go-context witness
  //   - missing_executable (agent CLI binary not on PATH)
  //   - version_unsupported (CLI version rejected by server)
  // These were deliberately not ported (verify-dupes.md / verify-commits.md
  // cross-check judged them optional for agentboster — the strings are
  // CLI-backend-specific and may never surface here). If misclassifications
  // to AGENT_UNKNOWN start clustering on the failure dashboards, port the
  // relevant witnesses + add fixtures mirroring classify_test.go.
  return FAILURE_REASON.AGENT_UNKNOWN;
}
