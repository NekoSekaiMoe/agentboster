import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/core/db/memory/long-term', () => ({
  listLongTermMemoryRows: vi.fn(),
  getMemoryMetaByIds: vi.fn().mockResolvedValue(new Map()),
  recordRecallHits: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/security/l1-scorer', () => ({
  scoreMemoryRelevance: vi.fn(),
}));

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { listLongTermMemoryRows } from '@/lib/core/db/memory/long-term';
import { scoreMemoryRelevance } from '@/lib/security/l1-scorer';
import type { AppConfig } from '@/types/config';
import {
  formatRecalledMemoriesForContext,
  recallRelevantMemories,
  resolveRecallStrategy,
  resolveScorerModelId,
} from './recall';

const USER_ID = 'user-uuid-1';

function makeConfig(
  overrides: Partial<AppConfig['models']> &
    Partial<Pick<AppConfig, 'security'>> = {},
): AppConfig {
  return {
    models: {
      model: 'main-model',
      ...overrides,
    },
    security: overrides.security,
  } as AppConfig;
}

describe('resolveRecallStrategy', () => {
  it('honors an explicit strategy', () => {
    const config = makeConfig({ memory_recall_strategy: 'scorer' });
    expect(resolveRecallStrategy(config)).toBe('scorer');
  });

  it('defaults to vector when an embedding model is configured', () => {
    const config = makeConfig({ embedding_model: 'text-embedding-3-small' });
    expect(resolveRecallStrategy(config)).toBe('vector');
  });

  it('defaults to scorer when no embedding model is configured', () => {
    const config = makeConfig();
    expect(resolveRecallStrategy(config)).toBe('scorer');
  });

  it('explicit vector wins even without embedding_model', () => {
    // The user picked vector — respect it. The scorer UI guards against
    // this combo, but the resolver itself doesn't second-guess.
    const config = makeConfig({ memory_recall_strategy: 'vector' });
    expect(resolveRecallStrategy(config)).toBe('vector');
  });
});

describe('resolveScorerModelId', () => {
  it('prefers the L1 scorer model when set', () => {
    const config = makeConfig({});
    config.security = { l1_scorer_model: 'flash-model' };
    expect(resolveScorerModelId(config)).toBe('flash-model');
  });

  it('falls back to the main chat model', () => {
    const config = makeConfig();
    expect(resolveScorerModelId(config)).toBe('main-model');
  });

  it('returns null when neither is configured', () => {
    const config = { models: {} } as AppConfig;
    expect(resolveScorerModelId(config)).toBeNull();
  });
});

describe('recallRelevantMemories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns [] when userId is missing', async () => {
    const result = await recallRelevantMemories({
      userId: null,
      query: 'where do I live',
      config: makeConfig(),
    });
    expect(result).toEqual([]);
  });

  it('returns [] when query is empty', async () => {
    const result = await recallRelevantMemories({
      userId: USER_ID,
      query: '   ',
      config: makeConfig(),
    });
    expect(result).toEqual([]);
  });

  it('scorer strategy: returns [] when no candidates available', async () => {
    // Both keyword and recency come back empty.
    vi.mocked(listLongTermMemoryRows).mockResolvedValueOnce([]);

    // Inline-mock the search module for this test only.
    vi.resetModules();
    vi.doMock('@/lib/memory/long-term', () => ({
      searchLongTermMemories: vi.fn().mockResolvedValue([]),
    }));
    const { recallRelevantMemories: recalled } = await import('./recall');

    const result = await recalled({
      userId: USER_ID,
      query: 'anything',
      config: makeConfig({ memory_recall_strategy: 'scorer' }),
    });

    expect(result).toEqual([]);
    vi.doUnmock('@/lib/memory/long-term');
  });

  it('scorer strategy: filters candidates through the scorer', async () => {
    vi.resetModules();
    const searchSpy = vi.fn().mockResolvedValue([
      {
        memoryId: 'm1',
        content: 'user lives in Tokyo',
        finalScore: 0.8,
      },
      {
        memoryId: 'm2',
        content: 'user likes spicy food',
        finalScore: 0.6,
      },
    ]);
    vi.doMock('@/lib/memory/long-term', () => ({
      searchLongTermMemories: searchSpy,
    }));

    vi.mocked(listLongTermMemoryRows).mockResolvedValue([]);
    vi.mocked(scoreMemoryRelevance).mockResolvedValue({
      relevantIds: ['m1'],
      reasons: { m1: 'location needed for weather query' },
    });

    const { recallRelevantMemories: recalled } = await import('./recall');

    const result = await recalled({
      userId: USER_ID,
      query: 'weather near me',
      config: makeConfig({ memory_recall_strategy: 'scorer' }),
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('user lives in Tokyo');
    // Scorer must have been called with both candidates.
    expect(scoreMemoryRelevance).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: 'weather near me',
        candidates: expect.arrayContaining([
          expect.objectContaining({ id: 'm1' }),
          expect.objectContaining({ id: 'm2' }),
        ]),
      }),
    );
    vi.doUnmock('@/lib/memory/long-term');
  });

  it('scorer strategy: returns [] when scorer selects nothing', async () => {
    vi.resetModules();
    vi.doMock('@/lib/memory/long-term', () => ({
      searchLongTermMemories: vi
        .fn()
        .mockResolvedValue([
          { memoryId: 'm1', content: 'irrelevant', finalScore: 0.5 },
        ]),
    }));
    vi.mocked(listLongTermMemoryRows).mockResolvedValue([]);
    vi.mocked(scoreMemoryRelevance).mockResolvedValue({
      relevantIds: [],
      reasons: {},
    });

    const { recallRelevantMemories: recalled } = await import('./recall');

    const result = await recalled({
      userId: USER_ID,
      query: 'explain React hooks',
      config: makeConfig({ memory_recall_strategy: 'scorer' }),
    });

    expect(result).toEqual([]);
    vi.doUnmock('@/lib/memory/long-term');
  });

  it('scorer strategy: returns [] when scorer model is unavailable', async () => {
    // No l1_scorer_model, no main model.
    const config = { models: {} } as AppConfig;
    const result = await recallRelevantMemories({
      userId: USER_ID,
      query: 'weather',
      config,
    });
    expect(result).toEqual([]);
  });
});

describe('formatRecalledMemoriesForContext', () => {
  it('returns null when memories is empty', () => {
    expect(formatRecalledMemoriesForContext([])).toBeNull();
  });

  it('renders a numbered list under the [Relevant Long-term Memories] header', () => {
    const text = formatRecalledMemoriesForContext([
      { content: 'user lives in Tokyo', score: 1 },
      { content: 'user prefers Japanese', score: 1 },
    ]);
    expect(text).toContain('[Relevant Long-term Memories]');
    expect(text).toContain('1. user lives in Tokyo');
    expect(text).toContain('2. user prefers Japanese');
    expect(text).toContain('authoritative personal context');
  });
});
