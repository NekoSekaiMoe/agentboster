import { describe, expect, it } from 'vitest';
import {
  applyClientSpoofHeaders,
  applyClientSpoofOverride,
  getEffectiveProviderClientSpoof,
} from './client-spoof';
import type { AppConfig } from '@/types/config';

describe('client spoof helpers', () => {
  it('applies Claude Code headers only to Anthropic providers', () => {
    expect(
      applyClientSpoofHeaders('anthropic', undefined, 'claude-code'),
    ).toEqual({
      'User-Agent': 'claude-code/1.0',
    });
    expect(
      applyClientSpoofHeaders('openai', undefined, 'claude-code'),
    ).toBeUndefined();
  });

  it('applies Codex headers only to OpenAI providers', () => {
    expect(applyClientSpoofHeaders('openai', {}, 'codex')).toEqual({
      'User-Agent': 'codex-cli/1.0',
    });
    expect(applyClientSpoofHeaders('openaicompatible', {}, 'codex')).toEqual(
      {},
    );
  });

  it('never spoofs Codex on OpenAI Legacy (Chat Completions)', () => {
    expect(applyClientSpoofHeaders('openai', {}, 'codex', 'chat')).toEqual({});
    expect(getEffectiveProviderClientSpoof('openai', 'codex', 'chat')).toBe(
      'off',
    );
    expect(
      getEffectiveProviderClientSpoof('openai', 'codex', 'responses'),
    ).toBe('codex');
  });

  it('applies Antigravity headers only to Google (Gemini) providers', () => {
    expect(applyClientSpoofHeaders('google', {}, 'antigravity')).toEqual({
      'User-Agent': 'antigravity-cli/1.0',
    });
    expect(applyClientSpoofHeaders('openai', {}, 'antigravity')).toEqual({});
    expect(applyClientSpoofHeaders('anthropic', {}, 'antigravity')).toEqual({});
  });

  it('overrides existing user-agent headers case-insensitively', () => {
    expect(
      applyClientSpoofHeaders(
        'openai',
        { 'user-agent': 'custom', 'x-test': '1' },
        'codex',
      ),
    ).toEqual({
      'x-test': '1',
      'User-Agent': 'codex-cli/1.0',
    });
  });

  it('exposes effective off for unsupported provider formats', () => {
    expect(getEffectiveProviderClientSpoof('anthropic', 'codex')).toBe('off');
    expect(getEffectiveProviderClientSpoof('openai', 'codex')).toBe('codex');
  });

  it('can override stored provider spoof settings for one run', () => {
    const config: AppConfig = {
      models: {
        temperature: 0.7,
        context_limit: 128_000,
        max_output_tokens: 8_192,
        providers: {
          anthropic: {
            format: 'anthropic',
            client_spoof: 'claude-code',
          },
          openai: {
            format: 'openai',
          },
        },
      },
    };

    expect(applyClientSpoofOverride(config, 'codex')).toEqual({
      models: {
        temperature: 0.7,
        context_limit: 128_000,
        max_output_tokens: 8_192,
        providers: {
          anthropic: {
            format: 'anthropic',
            client_spoof: 'codex',
          },
          openai: {
            format: 'openai',
            client_spoof: 'codex',
          },
        },
      },
    });

    expect(applyClientSpoofOverride(config, 'off')).toEqual({
      models: {
        temperature: 0.7,
        context_limit: 128_000,
        max_output_tokens: 8_192,
        providers: {
          anthropic: {
            format: 'anthropic',
          },
          openai: {
            format: 'openai',
          },
        },
      },
    });
  });
});
