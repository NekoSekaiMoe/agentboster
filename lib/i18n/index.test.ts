import { describe, expect, it } from 'vitest';

import { translatePlural } from './index';

const modelCountKeys = {
  one: 'config.trace.modelCount.one',
  other: 'config.trace.modelCount.other',
} as const;

describe('translatePlural', () => {
  it('selects singular and plural English forms', () => {
    expect(translatePlural('en-US', modelCountKeys, 0)).toBe('0 models');
    expect(translatePlural('en-US', modelCountKeys, 1)).toBe('1 model');
    expect(translatePlural('en-US', modelCountKeys, 2)).toBe('2 models');
  });

  it('uses locale rules while preserving languages without noun inflection', () => {
    expect(translatePlural('zh-CN', modelCountKeys, 1)).toBe('1 个模型步骤');
    expect(translatePlural('zh-CN', modelCountKeys, 2)).toBe('2 个模型步骤');
  });
});
