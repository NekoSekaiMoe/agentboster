import { describe, expect, it } from 'vitest';

import { detectRecallIntent } from './recall-intent';

describe('detectRecallIntent', () => {
  it('detects English recall intent', () => {
    expect(detectRecallIntent('Do you remember what we decided?')).toBe(true);
    expect(
      detectRecallIntent('What did I say last time about the deploy?'),
    ).toBe(true);
    expect(detectRecallIntent('We discussed this previously, right?')).toBe(
      true,
    );
    expect(detectRecallIntent('what did we decide earlier today')).toBe(true);
  });

  it('detects Chinese recall intent', () => {
    expect(detectRecallIntent('你还记得我们之前讨论的部署方案吗')).toBe(true);
    expect(detectRecallIntent('上次说的那个问题怎么解决的')).toBe(true);
    expect(detectRecallIntent('我们之前决定用哪个框架来着')).toBe(true);
    expect(detectRecallIntent('我当时选的是什么配置')).toBe(true);
  });

  it('stays quiet on ordinary requests (lane 1 keeps serving them)', () => {
    expect(detectRecallIntent('fix this bug in the parser')).toBe(false);
    expect(detectRecallIntent('帮我写一个排序函数')).toBe(false);
    expect(detectRecallIntent('deploy to production now')).toBe(false);
    expect(detectRecallIntent('')).toBe(false);
    expect(detectRecallIntent('hi')).toBe(false);
  });
});
