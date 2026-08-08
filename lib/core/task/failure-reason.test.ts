import { describe, expect, it } from 'vitest';
import {
  ALL_FAILURE_REASONS,
  FAILURE_REASON,
  type FailureReason,
  classifyFailure,
  isAgentError,
  isRetryable,
} from './failure-reason';

describe('FAILURE_REASON constants', () => {
  it('exposes exactly 22 canonical values', () => {
    expect(ALL_FAILURE_REASONS).toHaveLength(22);
  });

  it('includes 8 platform-side values (no agent_error. prefix)', () => {
    const platform = ALL_FAILURE_REASONS.filter((r) => !isAgentError(r));
    expect(platform).toHaveLength(8);
    expect(platform).toContain(FAILURE_REASON.QUEUED_EXPIRED);
    expect(platform).toContain(FAILURE_REASON.RUNTIME_OFFLINE);
  });

  it('includes 14 agent_error.* values', () => {
    const agent = ALL_FAILURE_REASONS.filter(isAgentError);
    expect(agent).toHaveLength(14);
  });
});

describe('isRetryable', () => {
  it('returns true only for transient reasons', () => {
    expect(isRetryable(FAILURE_REASON.AGENT_PROVIDER_NETWORK)).toBe(true);
    expect(
      isRetryable(FAILURE_REASON.AGENT_PROVIDER_CAPACITY_OR_RATE_LIMIT),
    ).toBe(true);
    expect(isRetryable(FAILURE_REASON.AGENT_PROVIDER_SERVER_ERROR)).toBe(true);
    expect(isRetryable(FAILURE_REASON.SKILL_BUNDLE_UNAVAILABLE)).toBe(true);
  });

  it('returns false for non-transient reasons', () => {
    expect(isRetryable(FAILURE_REASON.AGENT_PROVIDER_AUTH_OR_ACCESS)).toBe(
      false,
    );
    expect(isRetryable(FAILURE_REASON.AGENT_CONTEXT_OVERFLOW)).toBe(false);
    expect(isRetryable(FAILURE_REASON.AGENT_REFUSAL)).toBe(false);
    expect(isRetryable(FAILURE_REASON.AGENT_BLOCKED)).toBe(false);
  });

  it('returns false for null/empty', () => {
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable('')).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});

describe('classifyFailure', () => {
  it('returns AGENT_UNKNOWN for empty/whitespace input', () => {
    expect(classifyFailure('')).toBe(FAILURE_REASON.AGENT_UNKNOWN);
    expect(classifyFailure('   ')).toBe(FAILURE_REASON.AGENT_UNKNOWN);
    expect(classifyFailure(null)).toBe(FAILURE_REASON.AGENT_UNKNOWN);
    expect(classifyFailure(undefined)).toBe(FAILURE_REASON.AGENT_UNKNOWN);
  });

  // Rule-by-rule fixtures ported from Multica's classify_test.go (MUL-1949).
  const cases: Array<[string, FailureReason]> = [
    // 1. Context overflow.
    [
      'Error: context length exceeded for model gpt-4',
      FAILURE_REASON.AGENT_CONTEXT_OVERFLOW,
    ],
    [
      'Maximum context window of 200000 tokens has been exceeded',
      FAILURE_REASON.AGENT_CONTEXT_OVERFLOW,
    ],
    [
      'prompt is too long: 250000 tokens > 200000 maximum',
      FAILURE_REASON.AGENT_CONTEXT_OVERFLOW,
    ],
    [
      'Hit the token limit for this conversation',
      FAILURE_REASON.AGENT_CONTEXT_OVERFLOW,
    ],
    // Claude Code 2.1.x response-side overflow witnesses (GH #6360/#6402).
    // These carry neither 'token' nor 'limit'; without the witness list
    // they would fall through to AGENT_UNKNOWN and the over-full session
    // would stay pinned as the resume pointer, replaying the overflow.
    ['context window limit reached', FAILURE_REASON.AGENT_CONTEXT_OVERFLOW],
    [
      '{"stop_reason":"model_context_window_exceeded"}',
      FAILURE_REASON.AGENT_CONTEXT_OVERFLOW,
    ],
    ['error: prompt_too_long', FAILURE_REASON.AGENT_CONTEXT_OVERFLOW],

    // 2. Missing config.
    [
      'Missing environment variable: `MIFY_API_KEY`.',
      FAILURE_REASON.AGENT_MISSING_CONFIG,
    ],
    [
      'Failed to authenticate: missing api_key in config',
      FAILURE_REASON.AGENT_MISSING_CONFIG,
    ],
    [
      'no llm provider configured; set OPENAI_API_KEY',
      FAILURE_REASON.AGENT_MISSING_CONFIG,
    ],

    // 3. Provider auth / access.
    [
      'API Error: 401 Unauthorized',
      FAILURE_REASON.AGENT_PROVIDER_AUTH_OR_ACCESS,
    ],
    ['API Error: 403 Forbidden', FAILURE_REASON.AGENT_PROVIDER_AUTH_OR_ACCESS],
    [
      'Not logged in · Please run /login',
      FAILURE_REASON.AGENT_PROVIDER_AUTH_OR_ACCESS,
    ],
    ['Invalid API key provided', FAILURE_REASON.AGENT_PROVIDER_AUTH_OR_ACCESS],
    [
      'Your account does not have access to this model',
      FAILURE_REASON.AGENT_PROVIDER_AUTH_OR_ACCESS,
    ],

    // 4. Quota / billing.
    [
      'API Error: 402 Payment Required',
      FAILURE_REASON.AGENT_PROVIDER_QUOTA_LIMIT,
    ],
    [
      'balance is too low to make this request',
      FAILURE_REASON.AGENT_PROVIDER_QUOTA_LIMIT,
    ],
    ['You\u2019ve hit your limit', FAILURE_REASON.AGENT_PROVIDER_QUOTA_LIMIT],
    [
      'quota exceeded for project foo',
      FAILURE_REASON.AGENT_PROVIDER_QUOTA_LIMIT,
    ],

    // 5. Capacity / rate limit.
    [
      'API Error: 429 Too Many Requests',
      FAILURE_REASON.AGENT_PROVIDER_CAPACITY_OR_RATE_LIMIT,
    ],
    [
      'Server overloaded: HTTP 529',
      FAILURE_REASON.AGENT_PROVIDER_CAPACITY_OR_RATE_LIMIT,
    ],
    [
      'rate limit exceeded for tier 3',
      FAILURE_REASON.AGENT_PROVIDER_CAPACITY_OR_RATE_LIMIT,
    ],
    [
      'rate limit of 40000 input tokens per minute exceeded',
      FAILURE_REASON.AGENT_PROVIDER_CAPACITY_OR_RATE_LIMIT,
    ],
    // 'quota' appears in the string, so rule 4 (quota) claims this before
    // rule 5 (capacity) despite the rate_limit/per-minute phrasing. Asserts
    // the actual precedence; the primary rate-limit guard is the case above.
    [
      'rate_limit: per minute quota exceeded for tokens',
      FAILURE_REASON.AGENT_PROVIDER_QUOTA_LIMIT,
    ],

    // 6. Provider 5xx / server error.
    [
      'the server had an error processing your request',
      FAILURE_REASON.AGENT_PROVIDER_SERVER_ERROR,
    ],
    [
      'API Error: 500 Internal Server Error',
      FAILURE_REASON.AGENT_PROVIDER_SERVER_ERROR,
    ],
    ['got HTTP 503 from provider', FAILURE_REASON.AGENT_PROVIDER_SERVER_ERROR],
    ['upstream returned 504', FAILURE_REASON.AGENT_PROVIDER_SERVER_ERROR],
    [
      'service unavailable, retry later',
      FAILURE_REASON.AGENT_PROVIDER_SERVER_ERROR,
    ],
    [
      'Bad Gateway: upstream rejected',
      FAILURE_REASON.AGENT_PROVIDER_SERVER_ERROR,
    ],

    // 7. Provider network.
    [
      'stream disconnected before completion',
      FAILURE_REASON.AGENT_PROVIDER_NETWORK,
    ],
    [
      'API Error: Connection closed mid-response. The response above may be incomplete.',
      FAILURE_REASON.AGENT_PROVIDER_NETWORK,
    ],
    [
      'error sending request for url (https://api.example.com/v1)',
      FAILURE_REASON.AGENT_PROVIDER_NETWORK,
    ],
    [
      'read tcp 1.2.3.4:443: i/o timeout',
      FAILURE_REASON.AGENT_PROVIDER_NETWORK,
    ],
    ['context deadline exceeded', FAILURE_REASON.AGENT_PROVIDER_NETWORK],
    ['connection refused', FAILURE_REASON.AGENT_PROVIDER_NETWORK],

    // 8. Process failure.
    ['claude exited with exit status 1', FAILURE_REASON.AGENT_PROCESS_FAILURE],
    ['signal: killed', FAILURE_REASON.AGENT_PROCESS_FAILURE],

    // 9. Refusal.
    ["I can't help with that.", FAILURE_REASON.AGENT_REFUSAL],
    ['content policy violation', FAILURE_REASON.AGENT_REFUSAL],

    // 10. Tool failure.
    ['tool failed: bash exited 1', FAILURE_REASON.AGENT_TOOL_FAILURE],
    ['sandbox exec failed', FAILURE_REASON.AGENT_TOOL_FAILURE],

    // 11. Invalid response.
    ['invalid JSON in response body', FAILURE_REASON.AGENT_INVALID_RESPONSE],

    // Fallback.
    ['something completely unexpected happened', FAILURE_REASON.AGENT_UNKNOWN],
  ];

  for (const [input, expected] of cases) {
    it(`${input.slice(0, 60)}${input.length > 60 ? '…' : ''} → ${expected}`, () => {
      expect(classifyFailure(input)).toBe(expected);
    });
  }

  it('does not misclassify embedded numbers as status codes (digit-boundary guard)', () => {
    // "402913 tokens" must NOT match the 402 (quota) regex.
    expect(classifyFailure('input: 402913 tokens used')).toBe(
      FAILURE_REASON.AGENT_UNKNOWN,
    );
    // "exit status 4030" must NOT match the 401/403 (auth) regex.
    expect(classifyFailure('exit status 4030')).toBe(
      FAILURE_REASON.AGENT_PROCESS_FAILURE,
    );
    // "1500ms" must NOT match the 5xx regex.
    expect(classifyFailure('request took 1500ms')).toBe(
      FAILURE_REASON.AGENT_UNKNOWN,
    );
  });

  it('resists word-boundary false positives for oom/safety', () => {
    // 'room' must not trigger the 'oom' needle (word-boundary guard).
    expect(classifyFailure('no room left on device')).toBe(
      FAILURE_REASON.AGENT_UNKNOWN,
    );
    // Standalone 'oom' (and 'out of memory') still classify as process failure.
    expect(classifyFailure('oom conditions reported by kernel')).toBe(
      FAILURE_REASON.AGENT_PROCESS_FAILURE,
    );
    // Standalone 'safety' still classifies as refusal — the word-boundary
    // guard only stops substring matches like 'safetyNet', not real words.
    expect(classifyFailure('safety checks disabled')).toBe(
      FAILURE_REASON.AGENT_REFUSAL,
    );
    expect(classifyFailure('this message violates our safety policy')).toBe(
      FAILURE_REASON.AGENT_REFUSAL,
    );
  });
});
