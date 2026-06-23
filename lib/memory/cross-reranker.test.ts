import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  type CrossRerankConfig,
  crossRerankCandidates,
  parseRerankResponse,
  resolveCrossRerankConfig,
  resolveRerankUrl,
} from './cross-reranker';
import type { AppConfig } from '@/types/config';

function makeConfig(overrides: Partial<AppConfig['models']> = {}): AppConfig {
  return { models: { ...overrides } } as AppConfig;
}

function makeCandidate(id: string, content: string, rrfScore = 0.5) {
  return { id, content, rrfScore };
}

function enabledConfig(
  overrides: Partial<CrossRerankConfig> = {},
): CrossRerankConfig {
  return {
    enabled: true,
    protocol: 'jina',
    model: 'bge-reranker-v2-m3',
    apiUrl: 'https://rerank.example.com',
    apiKey: 'secret',
    topN: 3,
    timeoutSeconds: 10,
    ...overrides,
  };
}

describe('resolveCrossRerankConfig', () => {
  it('returns null when no config', () => {
    expect(resolveCrossRerankConfig(undefined)).toBeNull();
    expect(resolveCrossRerankConfig(makeConfig())).toBeNull();
  });

  it('returns null when disabled', () => {
    expect(
      resolveCrossRerankConfig(
        makeConfig({
          cross_rerank: {
            enabled: false,
            protocol: 'jina',
            timeout_seconds: 10,
          },
        }),
      ),
    ).toBeNull();
  });

  it('honors legacy cross_rerank_enabled scalar', () => {
    const resolved = resolveCrossRerankConfig(
      makeConfig({ cross_rerank_enabled: true }),
    );
    expect(resolved).not.toBeNull();
    expect(resolved?.enabled).toBe(true);
    expect(resolved?.protocol).toBe('jina');
  });

  it('reads structured config with defaults', () => {
    const resolved = resolveCrossRerankConfig(
      makeConfig({
        cross_rerank: {
          enabled: true,
          protocol: 'dashscope',
          model: 'qwen-reranker',
          api_url: 'https://dashscope.aliyuncs.com',
          api_key: 'k',
          top_n: 7,
          timeout_seconds: 10,
        },
      }),
    );
    expect(resolved).toEqual({
      enabled: true,
      protocol: 'dashscope',
      model: 'qwen-reranker',
      apiUrl: 'https://dashscope.aliyuncs.com',
      apiKey: 'k',
      topN: 7,
      timeoutSeconds: 10,
    });
  });
});

describe('resolveRerankUrl', () => {
  it('appends /rerank for jina when base has no path', () => {
    expect(
      resolveRerankUrl(
        enabledConfig({
          protocol: 'jina',
          apiUrl: 'https://api.jina.ai/v1',
        }),
      ),
    ).toBe('https://api.jina.ai/v1/rerank');
  });

  it('preserves base when path is already present', () => {
    expect(
      resolveRerankUrl(
        enabledConfig({
          protocol: 'jina',
          apiUrl: 'https://api.jina.ai/v1/rerank',
        }),
      ),
    ).toBe('https://api.jina.ai/v1/rerank');
  });

  it('appends dashscope path for dashscope protocol', () => {
    expect(
      resolveRerankUrl(
        enabledConfig({
          protocol: 'dashscope',
          apiUrl: 'https://dashscope.aliyuncs.com',
        }),
      ),
    ).toBe(
      'https://dashscope.aliyuncs.com/services/rerank/text-rerank/text-rerank',
    );
  });

  it('strips trailing slashes', () => {
    expect(
      resolveRerankUrl(
        enabledConfig({
          protocol: 'jina',
          apiUrl: 'https://api.jina.ai/v1/',
        }),
      ),
    ).toBe('https://api.jina.ai/v1/rerank');
  });
});

describe('parseRerankResponse', () => {
  it('parses jina-style flat envelope', () => {
    const data = {
      results: [
        { index: 2, relevance_score: 0.91 },
        { index: 0, relevance_score: 0.42 },
      ],
    };
    expect(parseRerankResponse(data, 'jina')).toEqual([
      { index: 2, score: 0.91 },
      { index: 0, score: 0.42 },
    ]);
  });

  it('parses dashscope-style nested envelope', () => {
    const data = {
      output: {
        results: [
          { index: 1, relevance_score: 0.7 },
          { index: 3, score: 0.1 },
        ],
      },
      request_id: 'abc',
    };
    expect(parseRerankResponse(data, 'dashscope')).toEqual([
      { index: 1, score: 0.7 },
      { index: 3, score: 0.1 },
    ]);
  });

  it('accepts both relevance_score and score field', () => {
    const data = {
      results: [
        { index: 0, score: 0.55 },
        { index: 1, relevance_score: 0.66 },
      ],
    };
    expect(parseRerankResponse(data, 'jina')).toHaveLength(2);
  });

  it('returns empty for non-array results', () => {
    expect(parseRerankResponse({ results: 'nope' }, 'jina')).toEqual([]);
    expect(parseRerankResponse({}, 'jina')).toEqual([]);
    expect(parseRerankResponse(null, 'jina')).toEqual([]);
  });

  it('rejects non-integer index and non-finite score', () => {
    const data = {
      results: [
        { index: 0.5, relevance_score: 0.9 },
        { index: 1, relevance_score: Number.NaN },
        { index: 2, relevance_score: 0.3 },
      ],
    };
    expect(parseRerankResponse(data, 'jina')).toEqual([
      { index: 2, score: 0.3 },
    ]);
  });
});

describe('crossRerankCandidates', () => {
  it('returns empty for empty input', async () => {
    const result = await crossRerankCandidates({
      query: 'q',
      candidates: [],
      config: enabledConfig(),
      topN: 5,
    });
    expect(result).toEqual([]);
  });

  it('passthrough when pool <= topN (no HTTP call)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const candidates = [makeCandidate('a', 'foo'), makeCandidate('b', 'bar')];
    const result = await crossRerankCandidates({
      query: 'q',
      candidates,
      config: enabledConfig(),
      topN: 5,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.rerankSource === 'passthrough')).toBe(true);
    fetchSpy.mockRestore();
  });

  it('passthrough when apiUrl/apiKey/model missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeCandidate(`id${i}`, `c${i}`),
    );
    const result = await crossRerankCandidates({
      query: 'q',
      candidates,
      config: enabledConfig({ apiUrl: undefined }),
      topN: 3,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.id)).toEqual(['id0', 'id1', 'id2']);
    expect(result.every((r) => r.rerankSource === 'passthrough')).toBe(true);
    fetchSpy.mockRestore();
  });

  it('reorders by upstream score and fills missing indices', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { index: 4, relevance_score: 0.9 },
            { index: 1, relevance_score: 0.7 },
          ],
        }),
        { status: 200 },
      ),
    );

    const candidates = Array.from({ length: 6 }, (_, i) =>
      makeCandidate(`id${i}`, `c${i}`, 0.1 * i),
    );
    const result = await crossRerankCandidates({
      query: 'q',
      candidates,
      config: enabledConfig(),
      topN: 3,
    });

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      id: 'id4',
      rerankScore: 0.9,
      rerankSource: 'model',
    });
    expect(result[1]).toMatchObject({
      id: 'id1',
      rerankScore: 0.7,
      rerankSource: 'model',
    });
    expect(result[2].rerankSource).toBe('fill');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('fail-open on upstream HTTP error', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('upstream down', { status: 503 }));

    const candidates = Array.from({ length: 6 }, (_, i) =>
      makeCandidate(`id${i}`, `c${i}`),
    );
    const result = await crossRerankCandidates({
      query: 'q',
      candidates,
      config: enabledConfig(),
      topN: 3,
    });

    expect(result).toHaveLength(3);
    expect(result.map((r) => r.id)).toEqual(['id0', 'id1', 'id2']);
    expect(result.every((r) => r.rerankSource === 'error')).toBe(true);
    fetchSpy.mockRestore();
  });

  it('fail-open on network rejection', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('ECONNRESET'));

    const candidates = Array.from({ length: 6 }, (_, i) =>
      makeCandidate(`id${i}`, `c${i}`),
    );
    const result = await crossRerankCandidates({
      query: 'q',
      candidates,
      config: enabledConfig(),
      topN: 2,
    });

    expect(result).toHaveLength(2);
    expect(result.every((r) => r.rerankSource === 'error')).toBe(true);
    fetchSpy.mockRestore();
  });

  it('fail-open on empty upstream results', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );

    const candidates = Array.from({ length: 6 }, (_, i) =>
      makeCandidate(`id${i}`, `c${i}`),
    );
    const result = await crossRerankCandidates({
      query: 'q',
      candidates,
      config: enabledConfig(),
      topN: 3,
    });

    expect(result.map((r) => r.id)).toEqual(['id0', 'id1', 'id2']);
    expect(result.every((r) => r.rerankSource === 'empty')).toBe(true);
    fetchSpy.mockRestore();
  });

  it('uses dashscope payload shape when protocol is dashscope', async () => {
    let capturedBody: unknown;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            output: {
              results: [{ index: 0, relevance_score: 0.88 }],
            },
          }),
          { status: 200 },
        );
      });

    const candidates = Array.from({ length: 4 }, (_, i) =>
      makeCandidate(`id${i}`, `c${i}`),
    );
    await crossRerankCandidates({
      query: 'q',
      candidates,
      config: enabledConfig({ protocol: 'dashscope' }),
      topN: 2,
    });

    expect(capturedBody).toMatchObject({
      model: 'bge-reranker-v2-m3',
      input: { query: 'q', documents: ['c0', 'c1', 'c2', 'c3'] },
      parameters: { top_n: 2, return_documents: false },
    });
    fetchSpy.mockRestore();
  });

  it('uses jina payload shape when protocol is jina', async () => {
    let capturedBody: unknown;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({ results: [{ index: 0, relevance_score: 0.88 }] }),
          { status: 200 },
        );
      });

    const candidates = Array.from({ length: 4 }, (_, i) =>
      makeCandidate(`id${i}`, `c${i}`),
    );
    await crossRerankCandidates({
      query: 'q',
      candidates,
      config: enabledConfig({ protocol: 'jina' }),
      topN: 2,
    });

    expect(capturedBody).toMatchObject({
      model: 'bge-reranker-v2-m3',
      query: 'q',
      documents: ['c0', 'c1', 'c2', 'c3'],
      top_n: 2,
      return_documents: false,
    });
    expect(capturedBody).not.toHaveProperty('input');
    expect(capturedBody).not.toHaveProperty('parameters');
    fetchSpy.mockRestore();
  });

  it('preserves original rrfScore on every returned row', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ results: [{ index: 1, relevance_score: 0.99 }] }),
          { status: 200 },
        ),
      );

    const candidates = [
      makeCandidate('a', 'foo', 0.42),
      makeCandidate('b', 'bar', 0.17),
      makeCandidate('c', 'baz', 0.83),
    ];
    const result = await crossRerankCandidates({
      query: 'q',
      candidates,
      config: enabledConfig(),
      topN: 1,
    });

    expect(result[0]).toMatchObject({ id: 'b', rrfScore: 0.17 });
    expect(result[0].rerankScore).toBe(0.99);
    fetchSpy.mockRestore();
  });
});
