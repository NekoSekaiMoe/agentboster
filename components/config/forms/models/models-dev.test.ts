import { describe, expect, it } from 'vitest';
import type { ModelsDevCatalog } from './models-dev';
import { buildConfiguredProviderModelSuggestions } from './models-dev';

describe('buildConfiguredProviderModelSuggestions', () => {
  it('returns an empty array when there are no configured providers', () => {
    const catalog: ModelsDevCatalog = {
      anthropic: { models: { 'claude-sonnet-4': {} } },
    };
    expect(buildConfiguredProviderModelSuggestions([], catalog)).toEqual([]);
  });

  it('returns an empty array when the catalog is null', () => {
    expect(
      buildConfiguredProviderModelSuggestions(['anthropic', 'openai'], null),
    ).toEqual([]);
  });

  it('lists every model for each configured provider, scoped with the configured name', () => {
    const catalog: ModelsDevCatalog = {
      anthropic: {
        models: {
          'claude-sonnet-4': {},
          'claude-opus-4': {},
        },
      },
      openai: {
        models: {
          'gpt-4o': {},
          'gpt-4o-mini': {},
        },
      },
    };

    const result = buildConfiguredProviderModelSuggestions(
      ['openai', 'anthropic'],
      catalog,
    );

    expect(result).toEqual([
      'anthropic/claude-opus-4',
      'anthropic/claude-sonnet-4',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
    ]);
  });

  it('matches provider names case-insensitively but keeps configured casing in the output', () => {
    const catalog: ModelsDevCatalog = {
      Anthropic: {
        models: { 'claude-sonnet-4': {} },
      },
    };

    const result = buildConfiguredProviderModelSuggestions(
      ['anthropic'],
      catalog,
    );

    expect(result).toEqual(['anthropic/claude-sonnet-4']);
  });

  it('skips configured providers that are absent from the catalog', () => {
    const catalog: ModelsDevCatalog = {
      anthropic: { models: { 'claude-sonnet-4': {} } },
    };

    const result = buildConfiguredProviderModelSuggestions(
      ['anthropic', 'unknown-provider'],
      catalog,
    );

    expect(result).toEqual(['anthropic/claude-sonnet-4']);
  });

  it('deduplicates model ids that collide across configured providers', () => {
    const catalog: ModelsDevCatalog = {
      openai: { models: { 'gpt-4o': {} } },
    };

    const result = buildConfiguredProviderModelSuggestions(
      ['openai', 'openai'],
      catalog,
    );

    expect(result).toEqual(['openai/gpt-4o']);
  });
});
