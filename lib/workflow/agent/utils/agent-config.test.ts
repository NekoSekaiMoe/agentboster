import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@/types/config';
import {
  MAIN_AGENT_NAME,
  getAgentModelId,
  getMainAgentModelId,
  resolveMainAgentModelId,
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
});

describe('MAIN_AGENT_NAME', () => {
  it('is the string "main"', () => {
    expect(MAIN_AGENT_NAME).toBe('main');
  });
});
