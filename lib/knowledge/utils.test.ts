import { describe, expect, it } from 'vitest';

import type { KnowledgeSearchRow } from '@/lib/core/db/knowledge';

import { inferSourceKindFromSourceType, knowledgeHitToPackItem } from './utils';

function makeRow(
  overrides: Partial<KnowledgeSearchRow> = {},
): KnowledgeSearchRow {
  return {
    chunkId: 'chunk-1',
    knowledgeBaseId: 'kb-1',
    knowledgeBaseName: 'KB',
    knowledgeBasePriority: 0,
    knowledgeBaseVisibility: 'private',
    documentId: 'doc-1',
    documentTitle: 'Doc',
    documentSourceType: 'text',
    documentSourceUri: null,
    documentCreatedAt: new Date(),
    content: 'hello world',
    vectorScore: 0.5,
    keywordScore: 0,
    finalScore: 0.7,
    ...overrides,
  };
}

describe('inferSourceKindFromSourceType', () => {
  it('url(自动抓取)→ tool_observed(进 Unverified 段)', () => {
    expect(inferSourceKindFromSourceType('url')).toBe('tool_observed');
  });

  it('file/text/import(用户主动提供)→ user_asserted', () => {
    expect(inferSourceKindFromSourceType('file')).toBe('user_asserted');
    expect(inferSourceKindFromSourceType('text')).toBe('user_asserted');
    expect(inferSourceKindFromSourceType('import')).toBe('user_asserted');
  });
});

describe('knowledgeHitToPackItem', () => {
  it('正常行映射成 PackItem,标记为 knowledge 源', () => {
    // makeRow 默认 documentSourceType='text' → user_asserted
    const item = knowledgeHitToPackItem(makeRow());
    expect(item).toEqual({
      text: 'hello world',
      score: 0.7,
      sourceKind: 'user_asserted',
      source: 'knowledge',
      memoryId: 'kb:chunk-1',
    });
  });

  it('sourceKind 按 documentSourceType 推断(url=tool_observed, 其余=user_asserted)', () => {
    expect(
      knowledgeHitToPackItem(makeRow({ documentSourceType: 'url' })).sourceKind,
    ).toBe('tool_observed');
    expect(
      knowledgeHitToPackItem(makeRow({ documentSourceType: 'file' }))
        .sourceKind,
    ).toBe('user_asserted');
    expect(
      knowledgeHitToPackItem(makeRow({ documentSourceType: 'import' }))
        .sourceKind,
    ).toBe('user_asserted');
  });

  it('finalScore clamp 到 [0,1](RRF 权重可能略微越界)', () => {
    expect(knowledgeHitToPackItem(makeRow({ finalScore: 1.5 })).score).toBe(1);
    expect(knowledgeHitToPackItem(makeRow({ finalScore: -0.3 })).score).toBe(0);
  });

  it('finalScore 非有限数时给中性 0.5', () => {
    expect(
      knowledgeHitToPackItem(makeRow({ finalScore: Number.NaN })).score,
    ).toBe(0.5);
  });

  it('content 两端空白被 trim(防 packer 预算浪费)', () => {
    const item = knowledgeHitToPackItem(
      makeRow({ content: '  spaced content  ' }),
    );
    expect(item.text).toBe('spaced content');
  });

  it('content 为空串时 text 为空(调用方负责过滤,不占位)', () => {
    const item = knowledgeHitToPackItem(makeRow({ content: '   ' }));
    expect(item.text).toBe('');
  });

  it('memoryId 加 kb: 前缀,避免与 memory/远程 provider 命名空间碰撞', () => {
    const item = knowledgeHitToPackItem(makeRow({ chunkId: 'abc' }));
    expect(item.memoryId).toBe('kb:abc');
  });
});
