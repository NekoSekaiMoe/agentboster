import { describe, expect, it } from 'vitest';
import {
  assertPlanDagValid,
  validatePlanDag,
  type PlanDagItem,
} from './plan-dag';

function items(...list: Array<[string, string[]]>): PlanDagItem[] {
  return list.map(([itemId, dependsOn]) => ({ itemId, dependsOn }));
}

describe('validatePlanDag', () => {
  it('accepts a valid DAG', () => {
    const issues = validatePlanDag(
      items(['a', []], ['b', ['a']], ['c', ['a']], ['d', ['b', 'c']]),
    );
    expect(issues).toEqual([]);
  });

  it('flags an empty plan', () => {
    expect(validatePlanDag([])).toEqual([
      { code: 'EMPTY', message: expect.any(String) },
    ]);
  });

  it('flags self dependencies', () => {
    const issues = validatePlanDag(items(['a', []], ['b', ['b']]));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'SELF_DEPENDENCY',
      itemId: 'b',
    });
  });

  it('flags unknown dependencies with the target id', () => {
    const issues = validatePlanDag(items(['a', ['ghost']]));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'UNKNOWN_DEPENDENCY',
      itemId: 'a',
      dependsOnItemId: 'ghost',
    });
  });

  it('flags direct cycles and separately lists blocked items', () => {
    const issues = validatePlanDag(
      items(['a', []], ['b', ['c']], ['c', ['b']], ['d', ['b']]),
    );
    expect(issues.map((i) => i.code)).toEqual(['CYCLE', 'BLOCKED_BY_CYCLE']);
    expect(issues[0].message).toContain('b');
    expect(issues[0].message).toContain('c');
    expect(issues[1].message).toContain('d');
  });

  it('flags a self-loop as SELF_DEPENDENCY, not as a cycle', () => {
    const issues = validatePlanDag(items(['a', ['a']]));
    expect(issues.map((i) => i.code)).toEqual(['SELF_DEPENDENCY']);
  });

  it('flags duplicate item ids defensively', () => {
    const issues = validatePlanDag(items(['a', []], ['a', []]));
    expect(issues.map((i) => i.code)).toEqual(['DUPLICATE_ITEM']);
  });

  it('ignores duplicate dependsOn entries when counting edges', () => {
    const issues = validatePlanDag(items(['a', []], ['b', ['a', 'a']]));
    expect(issues).toEqual([]);
  });
});

describe('assertPlanDagValid', () => {
  it('passes silently for a valid DAG', () => {
    expect(() => assertPlanDagValid(items(['a', []]))).not.toThrow();
  });

  it('throws with every issue in the message', () => {
    expect(() => assertPlanDagValid(items(['a', ['a', 'ghost']]))).toThrow(
      /依赖它自己[\s\S]*不存在的任务 ghost/,
    );
  });
});
