import { describe, expect, it } from 'vitest';
import type { ModelsDevCatalog } from './models-dev';
import {
  buildConfiguredProviderModelSuggestions,
  buildEmbeddingModelPredictions,
  isLikelyEmbeddingModelId,
} from './models-dev';

describe('isLikelyEmbeddingModelId', () => {
  it('matches well-known embedding model ids', () => {
    for (const id of [
      'text-embedding-3-small',
      'openai/text-embedding-3-small',
      'gemini-embedding-001',
      'cohere-embed-v3-multilingual',
      'bge-m3',
      'gte-large-en-v1.5',
      'multilingual-e5-large-instruct',
      'mistral-embed',
      'qwen3-embedding-0.6b',
    ]) {
      expect(isLikelyEmbeddingModelId(id)).toBe(true);
    }
  });

  it('rejects chat models and rerankers', () => {
    for (const id of [
      'gpt-4o',
      'claude-sonnet-4',
      'deepseek-chat',
      'bge-reranker-v2-m3',
      'qwen3-reranker-4b',
    ]) {
      expect(isLikelyEmbeddingModelId(id)).toBe(false);
    }
  });
});

describe('buildEmbeddingModelPredictions', () => {
  it('keeps only likely embedding models, scoped with the configured name', () => {
    const catalog: ModelsDevCatalog = {
      openai: {
        models: {
          'gpt-4o': {},
          'text-embedding-3-small': {},
          'text-embedding-3-large': {},
        },
      },
      google: {
        models: {
          'gemini-2.5-pro': {},
          'gemini-embedding-001': {},
        },
      },
    };

    expect(
      buildEmbeddingModelPredictions(['openai', 'google'], catalog),
    ).toEqual([
      'google/gemini-embedding-001',
      'openai/text-embedding-3-large',
      'openai/text-embedding-3-small',
    ]);
  });

  it('returns an empty array when the catalog is null', () => {
    expect(buildEmbeddingModelPredictions(['openai'], null)).toEqual([]);
  });
});

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
