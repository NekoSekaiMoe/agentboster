import { describe, expect, it } from 'vitest';
import type { AssistantMessage } from '../types.ts';
import { isContextOverflow } from './overflow.ts';
import { isRetryableAssistantError } from './retry.ts';

function errorMessage(provider: string, message: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'anthropic-messages',
    provider,
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: message,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

describe('isContextOverflow (pi-ai 0.87.1 port)', () => {
  it.each([
    ['anthropic', 'prompt is too long: 213462 tokens > 200000 maximum'],
    ['z.ai', '{"code":"1261","message":"Prompt too long"}'],
    ['openai', 'Your input exceeds the context window of this model'],
    ['openrouter', "This endpoint's maximum context length is 8192 tokens."],
    ['cerebras', '413 (no body)'],
  ])('detects overflow for %s', (provider, message) => {
    expect(isContextOverflow(errorMessage(provider, message))).toBe(true);
  });

  it.each([
    ['anthropic', 'rate limit exceeded, too many requests'],
    ['bedrock', 'Throttling error: Too many tokens, please wait'],
    ['openai', 'invalid request body'],
  ])('does not classify %s throttling as overflow', (_provider, message) => {
    expect(isContextOverflow(errorMessage('x', message))).toBe(false);
  });

  it('detects silent overflow via usage exceeding context window', () => {
    const message = {
      ...errorMessage('z.ai', undefined as unknown as string),
      stopReason: 'stop' as const,
      usage: {
        input: 200_000,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 200_010,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    expect(isContextOverflow(message, 128_000)).toBe(true);
    expect(isContextOverflow(message)).toBe(false);
  });
});

describe('isRetryableAssistantError (pi-ai 0.87.1 port)', () => {
  it.each([
    '500 Internal Server Error',
    'Cloudflare 520 origin error',
    'The server is currently experiencing high demand',
    'fetch failed',
    'socket hang up',
  ])('classifies %s as retryable', (message) => {
    expect(isRetryableAssistantError(errorMessage('x', message))).toBe(true);
  });

  it.each([
    'insufficient_quota: You exceeded your current quota',
    'billing hard limit reached',
    'Monthly usage limit reached',
  ])('classifies %s as non-retryable', (message) => {
    expect(isRetryableAssistantError(errorMessage('x', message))).toBe(false);
  });

  it('requires an error stop reason', () => {
    const message = {
      ...errorMessage('x', '500'),
      stopReason: 'stop' as const,
    };
    expect(isRetryableAssistantError(message)).toBe(false);
  });
});
