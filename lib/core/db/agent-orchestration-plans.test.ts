import { describe, expect, it } from 'vitest';
import {
  computeWaves,
  synthesizePlanInstruction,
  type PlanWithItems,
} from './agent-orchestration-plans';

function item(
  itemId: string,
  agentName: string,
  task: string,
  dependsOn: string[] = [],
  order = 0,
) {
  return {
    id: 'pk-' + itemId,
    planId: 'plan-pk',
    itemId,
    agentName,
    task,
    dependsOn,
    order,
    removed: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const basePlan = {
  id: 'pk',
  planId: 'plan-x',
  sessionId: 'sess-x',
  title: 'demo',
  description: null,
  status: 'draft' as const,
  submittedMessageId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('computeWaves', () => {
  it('empty list -> no waves', () => {
    expect(computeWaves([])).toEqual([]);
  });

  it('independent items go into wave 1 (sorted by order)', () => {
    const items = [item('a', 'r', 't1', [], 2), item('b', 'r', 't2', [], 1)];
    const waves = computeWaves(items);
    expect(waves).toHaveLength(1);
    expect(waves[0]!.map((i) => i.itemId)).toEqual(['b', 'a']);
  });

  it('depends_on sequences across waves', () => {
    const items = [
      item('a', 'r', 'root'),
      item('b', 'r', 'child', ['a']),
      item('c', 'r', 'grandchild', ['b']),
    ];
    const waves = computeWaves(items);
    expect(waves).toHaveLength(3);
    expect(waves[0]![0]!.itemId).toBe('a');
    expect(waves[1]![0]!.itemId).toBe('b');
    expect(waves[2]![0]!.itemId).toBe('c');
  });

  it('parallel within a wave, then a join', () => {
    const items = [
      item('a', 'r', 'leaf1'),
      item('b', 'r', 'leaf2'),
      item('c', 'r', 'join', ['a', 'b']),
    ];
    const waves = computeWaves(items);
    expect(waves).toHaveLength(2);
    expect(waves[0]!.map((i) => i.itemId).sort()).toEqual(['a', 'b']);
    expect(waves[1]![0]!.itemId).toBe('c');
  });

  it('cycle does not infinite-loop (stragglers dumped into a wave)', () => {
    const items = [item('a', 'r', 'x', ['b']), item('b', 'r', 'y', ['a'])];
    const waves = computeWaves(items);
    // Both stuck -> land in a single wave and stop.
    expect(waves.length).toBeLessThanOrEqual(2);
    const allIds = waves
      .flat()
      .map((i) => i.itemId)
      .sort();
    expect(allIds).toEqual(['a', 'b']);
  });

  it('missing dep reference is treated as never-ready then dumped', () => {
    const items = [item('a', 'r', 'x', ['ghost'])];
    const waves = computeWaves(items);
    expect(waves.length).toBeGreaterThanOrEqual(1);
    expect(waves.flat().map((i) => i.itemId)).toContain('a');
  });
});

describe('synthesizePlanInstruction', () => {
  it('produces a structured prompt with waves and per-item agent + task', () => {
    const plan: PlanWithItems = {
      ...basePlan,
      items: [
        item('a', 'researcher', 'find sources'),
        item('b', 'writer', 'draft post', ['a']),
      ],
    };
    const text = synthesizePlanInstruction(plan);
    expect(text).toContain('researcher');
    expect(text).toContain('writer');
    expect(text).toContain('find sources');
    expect(text).toContain('draft post');
    expect(text).toMatch(/Wave 1/);
    expect(text).toMatch(/Wave 2/);
  });

  it('includes description when present', () => {
    const plan: PlanWithItems = {
      ...basePlan,
      description: 'Ship the launch blog.',
      items: [],
    };
    expect(synthesizePlanInstruction(plan)).toContain('Ship the launch blog.');
  });

  it('notes dependency on items that have dependsOn', () => {
    const plan: PlanWithItems = {
      ...basePlan,
      items: [item('a', 'x', 'root'), item('b', 'y', 'child', ['a'])],
    };
    const text = synthesizePlanInstruction(plan);
    expect(text).toContain('依赖: a');
  });
});
