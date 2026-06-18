import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@/types/config';
import {
  MAIN_AGENT_NAME,
  getAgentModelId,
  getMainAgentModelId,
  resolveMainAgentModelId,
  resolveMainAgentModelParams,
} from './agent-config';

function makeConfig(model?: string): AppConfig {
  return {
    models: model ? { model } : {},
  } as AppConfig;
}

describe('getMainAgentModelId (global-only)', () => {
  it('returns the configured global model', () => {
    expect(getMainAgentModelId(makeConfig('gpt-4o'))).toBe('gpt-4o');
  });

  it('throws when no global model is set', () => {
    expect(() => getMainAgentModelId(makeConfig())).toThrow(
      /No model configured for the main agent/,
    );
  });
});

describe('getAgentModelId (global fallback)', () => {
  it('prefers the agent-specific override', () => {
    const config = {
      ...makeConfig('global-model'),
      agents: { researcher: { model: 'claude-sonnet-4' } },
    } as AppConfig;
    expect(getAgentModelId(config, 'researcher')).toBe('claude-sonnet-4');
  });

  it('falls back to the global model when no agent override exists', () => {
    expect(getAgentModelId(makeConfig('gpt-4o'), 'unknown')).toBe('gpt-4o');
  });
});

describe('resolveMainAgentModelId (per-user override)', () => {
  it('returns the per-user override when set', () => {
    const config = makeConfig('global-default');
    const user = { modelPreferences: { model: 'personal-pick' } };
    expect(resolveMainAgentModelId(config, user)).toBe('personal-pick');
  });

  it('falls back to the global model when user has no override', () => {
    const config = makeConfig('global-default');
    expect(resolveMainAgentModelId(config, { modelPreferences: null })).toBe(
      'global-default',
    );
    expect(resolveMainAgentModelId(config, { modelPreferences: {} })).toBe(
      'global-default',
    );
  });

  it('falls back to the global model when user is null/undefined', () => {
    const config = makeConfig('global-default');
    expect(resolveMainAgentModelId(config, null)).toBe('global-default');
    expect(resolveMainAgentModelId(config, undefined)).toBe('global-default');
  });

  it('treats an empty-string personal model as unset', () => {
    // defensive: the UI trims before saving, but make sure the resolver
    // never silently picks an empty id over a valid global default.
    const config = makeConfig('global-default');
    const user = { modelPreferences: { model: '' } };
    expect(resolveMainAgentModelId(config, user)).toBe('global-default');
  });

  it('throws when neither override nor global is set', () => {
    const config = makeConfig();
    expect(() => resolveMainAgentModelId(config, null)).toThrow(
      /No model configured for the main agent/,
    );
    expect(() =>
      resolveMainAgentModelId(config, { modelPreferences: { model: 'x' } }),
    ).not.toThrow();
  });

  it('honors per-message requestModel over user preference and global default', () => {
    const config = makeConfig('global-default');
    const user = { modelPreferences: { model: 'personal-pick' } };
    expect(resolveMainAgentModelId(config, user, 'request-pick')).toBe(
      'request-pick',
    );
  });

  it('falls through to user preference when requestModel is empty/whitespace', () => {
    const config = makeConfig('global-default');
    const user = { modelPreferences: { model: 'personal-pick' } };
    expect(resolveMainAgentModelId(config, user, undefined)).toBe(
      'personal-pick',
    );
    expect(resolveMainAgentModelId(config, user, null)).toBe('personal-pick');
    expect(resolveMainAgentModelId(config, user, '   ')).toBe('personal-pick');
    expect(resolveMainAgentModelId(config, user, '')).toBe('personal-pick');
  });

  it('trims requestModel before use', () => {
    const config = makeConfig('global-default');
    expect(
      resolveMainAgentModelId(config, null, '  free-chat/gemini-3  '),
    ).toBe('free-chat/gemini-3');
  });
});

describe('MAIN_AGENT_NAME', () => {
  it('is the string "main"', () => {
    expect(MAIN_AGENT_NAME).toBe('main');
  });
});

describe('resolveMainAgentModelParams (catalog overrides)', () => {
  it('returns global defaults when no catalog entry exists for the resolved model', () => {
    const config = {
      models: {
        model: 'gpt-4o',
        temperature: 0.5,
        context_limit: 100000,
        max_output_tokens: 4096,
      },
    } as AppConfig;

    const result = resolveMainAgentModelParams(config, null);
    expect(result.modelId).toBe('gpt-4o');
    expect(result.temperature).toBe(0.5);
    expect(result.contextLimit).toBe(100000);
    expect(result.outputLimit).toBe(4096);
  });

  it('applies catalog overrides for the resolved model', () => {
    const config = {
      models: {
        model: 'gpt-4o',
        temperature: 0.5,
        context_limit: 100000,
        max_output_tokens: 4096,
        model_catalog: {
          'gpt-4o': {
            temperature: 0.9,
            context_limit: 50000,
            max_output_tokens: 8192,
          },
        },
      },
    } as AppConfig;

    const result = resolveMainAgentModelParams(config, null);
    expect(result.modelId).toBe('gpt-4o');
    expect(result.temperature).toBe(0.9);
    expect(result.contextLimit).toBe(50000);
    expect(result.outputLimit).toBe(8192);
  });

  it('falls back to global default for any field the catalog entry leaves unset', () => {
    const config = {
      models: {
        model: 'gpt-4o',
        temperature: 0.5,
        context_limit: 100000,
        max_output_tokens: 4096,
        model_catalog: {
          'gpt-4o': {
            temperature: 0.9,
            // context_limit and max_output_tokens intentionally absent
          },
        },
      },
    } as AppConfig;

    const result = resolveMainAgentModelParams(config, null);
    expect(result.temperature).toBe(0.9);
    expect(result.contextLimit).toBe(100000);
    expect(result.outputLimit).toBe(4096);
  });

  it('honors per-user preference when looking up the catalog entry', () => {
    const config = {
      models: {
        model: 'gpt-4o',
        temperature: 0.5,
        context_limit: 100000,
        max_output_tokens: 4096,
        model_catalog: {
          'claude-sonnet-4': {
            temperature: 0.2,
            context_limit: 200000,
            max_output_tokens: 16384,
          },
        },
      },
    } as AppConfig;

    const user = { modelPreferences: { model: 'claude-sonnet-4' } };
    const result = resolveMainAgentModelParams(config, user);
    expect(result.modelId).toBe('claude-sonnet-4');
    expect(result.temperature).toBe(0.2);
    expect(result.contextLimit).toBe(200000);
    expect(result.outputLimit).toBe(16384);
  });

  it('falls back to built-in per-model context table when neither catalog nor config set context_limit', () => {
    const config = {
      models: {
        model: 'gpt-4o',
        // no context_limit, no catalog
      },
    } as AppConfig;

    const result = resolveMainAgentModelParams(config, null);
    // gpt-4o has a built-in 128_000 entry in MODEL_CONTEXT_SIZES
    expect(result.contextLimit).toBe(128_000);
  });

  it('falls back to built-in per-model output heuristics when neither catalog nor config set max_output_tokens', () => {
    const config = {
      models: {
        model: 'claude-sonnet-4',
        // no max_output_tokens, no catalog
      },
    } as AppConfig;

    const result = resolveMainAgentModelParams(config, null);
    // claude* models have a built-in 8_192 heuristic
    expect(result.outputLimit).toBe(8_192);
  });

  it('empty catalog object ({}) means "use global defaults for this model"', () => {
    const config = {
      models: {
        model: 'gpt-4o',
        temperature: 0.7,
        context_limit: 50000,
        max_output_tokens: 2048,
        model_catalog: {
          'gpt-4o': {},
        },
      },
    } as AppConfig;

    const result = resolveMainAgentModelParams(config, null);
    expect(result.modelId).toBe('gpt-4o');
    expect(result.temperature).toBe(0.7);
    expect(result.contextLimit).toBe(50000);
    expect(result.outputLimit).toBe(2048);
  });

  it('per-message requestModel wins over user preference and looks up its catalog entry', () => {
    const config = {
      models: {
        model: 'gpt-4o',
        temperature: 0.5,
        context_limit: 100000,
        max_output_tokens: 4096,
        model_catalog: {
          'claude-sonnet-4': {
            temperature: 0.2,
            context_limit: 200000,
            max_output_tokens: 16384,
          },
        },
      },
    } as AppConfig;

    // User has a persistent preference for gpt-4o, but the chat-box picker
    // asked for claude-sonnet-4 on this message. Resolver should pick the
    // request and apply claude-sonnet-4's catalog overrides.
    const user = { modelPreferences: { model: 'gpt-4o' } };
    const result = resolveMainAgentModelParams(config, user, 'claude-sonnet-4');
    expect(result.modelId).toBe('claude-sonnet-4');
    expect(result.temperature).toBe(0.2);
    expect(result.contextLimit).toBe(200000);
    expect(result.outputLimit).toBe(16384);
  });

  it('falls through to user/global when requestModel is undefined (memory-extraction path)', () => {
    const config = {
      models: {
        model: 'gpt-4o',
        temperature: 0.5,
        context_limit: 100000,
        max_output_tokens: 4096,
      },
    } as AppConfig;

    const user = { modelPreferences: { model: 'personal-pick' } };
    const result = resolveMainAgentModelParams(config, user);
    expect(result.modelId).toBe('personal-pick');
  });
});
