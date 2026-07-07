import { describe, expect, it } from 'vitest';
import {
  applyClientSpoofHeaders,
  applyClientSpoofOverride,
  getEffectiveProviderClientSpoof,
} from './client-spoof';
import type { AppConfig } from '@/types/config';

describe('client spoof helpers', () => {
  it('applies Claude Code headers for Anthropic when on', () => {
    expect(applyClientSpoofHeaders('anthropic', undefined, 'on')).toEqual({
      'User-Agent': 'claude-code/1.0',
    });
    expect(applyClientSpoofHeaders('openai', undefined, 'on')).not.toEqual({
      'User-Agent': 'claude-code/1.0',
    });
  });

  it('applies Codex headers only for OpenAI Responses (not Legacy)', () => {
    expect(applyClientSpoofHeaders('openai', {}, 'on')).toEqual({
      'User-Agent': 'codex-cli/1.0',
    });
    // Legacy Chat → no spoof
    expect(applyClientSpoofHeaders('openai', {}, 'on', 'chat')).toEqual({});
    // openaicompatible has no spoof profile
    expect(applyClientSpoofHeaders('openaicompatible', {}, 'on')).toEqual({});
  });

  it('applies Antigravity headers for Google when on', () => {
    expect(applyClientSpoofHeaders('google', {}, 'on')).toEqual({
      'User-Agent': 'antigravity-cli/1.0',
    });
    expect(applyClientSpoofHeaders('anthropic', {}, 'on')).not.toEqual({
      'User-Agent': 'antigravity-cli/1.0',
    });
  });

  it('returns original headers when spoof is off', () => {
    expect(
      applyClientSpoofHeaders('openai', { 'x-custom': '1' }, 'off'),
    ).toEqual({
      'x-custom': '1',
    });
    expect(
      applyClientSpoofHeaders('openai', { 'x-custom': '1' }, undefined),
    ).toEqual({
      'x-custom': '1',
    });
  });

  it('exposes effective off for unsupported provider formats', () => {
    expect(getEffectiveProviderClientSpoof('anthropic', 'on')).toBe('on');
    expect(getEffectiveProviderClientSpoof('openaicompatible', 'on')).toBe(
      'off',
    );
    expect(getEffectiveProviderClientSpoof('openai', 'on')).toBe('on');
    expect(getEffectiveProviderClientSpoof('google', 'on')).toBe('on');
  });

  it('drops Codex for OpenAI Legacy (Chat Completions)', () => {
    expect(getEffectiveProviderClientSpoof('openai', 'on', 'chat')).toBe('off');
    expect(getEffectiveProviderClientSpoof('openai', 'on', 'responses')).toBe(
      'on',
    );
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
            client_spoof: 'on',
          },
          openai: {
            format: 'openai',
          },
        },
      },
    };

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

    expect(applyClientSpoofOverride(config, 'on')).toEqual({
      models: {
        temperature: 0.7,
        context_limit: 128_000,
        max_output_tokens: 8_192,
        providers: {
          anthropic: {
            format: 'anthropic',
            client_spoof: 'on',
          },
          openai: {
            format: 'openai',
            client_spoof: 'on',
          },
        },
      },
    });
  });
});
