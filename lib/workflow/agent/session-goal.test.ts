/**
 * Tests for Session Goal continuation logic. The evaluator's LLM call is
 * mocked (it's an I/O boundary); the testable surface is the typed
 * GoalBlocker enum semantics and the shouldContinueWithHiddenRun decision
 * (all 4 preconditions + the 2 breakers).
 */
import { describe, expect, it } from 'vitest';
import {
  GoalBlocker,
  blockerPermitsContinuation,
  MAX_HIDDEN_CONTINUATIONS,
  MAX_IDENTICAL_NON_PROGRESS,
  shouldContinueWithHiddenRun,
} from './session-goal';

const green = {
  autoContinueEnabled: true,
  latestTurnCheckpointed: true,
  threadChangedDuringEvaluation: false,
  hiddenContinuationCount: 0,
  consecutiveIdenticalNonProgress: 0,
};

describe('session-goal: GoalBlocker continuation semantics', () => {
  it('only goal_not_met_yet permits continuation', () => {
    expect(blockerPermitsContinuation(GoalBlocker.goal_not_met_yet)).toBe(true);
    const stoppers: GoalBlocker[] = [
      GoalBlocker.none,
      GoalBlocker.missing_evidence,
      GoalBlocker.needs_user_input,
      GoalBlocker.run_failed,
      GoalBlocker.external_wait,
    ];
    for (const b of stoppers) {
      expect(blockerPermitsContinuation(b)).toBe(false);
    }
  });
});

describe('session-goal: shouldContinueWithHiddenRun — 4 preconditions', () => {
  it('continues when all preconditions hold and blocker is goal_not_met_yet', () => {
    const decision = shouldContinueWithHiddenRun({
      ...green,
      evaluation: {
        blocker: GoalBlocker.goal_not_met_yet,
        reasoning: 'still work to do',
      },
    });
    expect(decision.continue).toBe(true);
    expect(decision.denialReason).toBeNull();
  });

  it('denies when auto-continue is disabled (master switch off)', () => {
    const decision = shouldContinueWithHiddenRun({
      ...green,
      autoContinueEnabled: false,
      evaluation: {
        blocker: GoalBlocker.goal_not_met_yet,
        reasoning: 'x',
      },
    });
    expect(decision.continue).toBe(false);
    expect(decision.denialReason).toMatch(/disabled/);
  });

  it('denies when the latest turn is not checkpointed', () => {
    const decision = shouldContinueWithHiddenRun({
      ...green,
      latestTurnCheckpointed: false,
      evaluation: {
        blocker: GoalBlocker.goal_not_met_yet,
        reasoning: 'x',
      },
    });
    expect(decision.continue).toBe(false);
    expect(decision.denialReason).toMatch(/checkpointed/);
  });

  it('denies when the thread changed during evaluation', () => {
    const decision = shouldContinueWithHiddenRun({
      ...green,
      threadChangedDuringEvaluation: true,
      evaluation: {
        blocker: GoalBlocker.goal_not_met_yet,
        reasoning: 'x',
      },
    });
    expect(decision.continue).toBe(false);
    expect(decision.denialReason).toMatch(/thread changed/);
  });

  it('denies when the blocker is not goal_not_met_yet (even if all else is green)', () => {
    for (const blocker of [
      GoalBlocker.none,
      GoalBlocker.missing_evidence,
      GoalBlocker.needs_user_input,
      GoalBlocker.run_failed,
      GoalBlocker.external_wait,
    ] as GoalBlocker[]) {
      const decision = shouldContinueWithHiddenRun({
        ...green,
        evaluation: { blocker, reasoning: 'x' },
      });
      expect(decision.continue).toBe(false);
    }
  });
});

describe('session-goal: shouldContinueWithHiddenRun — breakers', () => {
  it('denies at MAX_HIDDEN_CONTINUATIONS', () => {
    const decision = shouldContinueWithHiddenRun({
      ...green,
      hiddenContinuationCount: MAX_HIDDEN_CONTINUATIONS,
      evaluation: {
        blocker: GoalBlocker.goal_not_met_yet,
        reasoning: 'x',
      },
    });
    expect(decision.continue).toBe(false);
    expect(decision.denialReason).toMatch(/max hidden continuations/);
  });

  it('allows one below MAX_HIDDEN_CONTINUATIONS', () => {
    const decision = shouldContinueWithHiddenRun({
      ...green,
      hiddenContinuationCount: MAX_HIDDEN_CONTINUATIONS - 1,
      evaluation: {
        blocker: GoalBlocker.goal_not_met_yet,
        reasoning: 'x',
      },
    });
    expect(decision.continue).toBe(true);
  });

  it('denies at MAX_IDENTICAL_NON_PROGRESS consecutive identical non-progress', () => {
    const decision = shouldContinueWithHiddenRun({
      ...green,
      consecutiveIdenticalNonProgress: MAX_IDENTICAL_NON_PROGRESS,
      evaluation: {
        blocker: GoalBlocker.goal_not_met_yet,
        reasoning: 'x',
      },
    });
    expect(decision.continue).toBe(false);
    expect(decision.denialReason).toMatch(/no-progress breaker/);
  });

  it('allows one below MAX_IDENTICAL_NON_PROGRESS', () => {
    const decision = shouldContinueWithHiddenRun({
      ...green,
      consecutiveIdenticalNonProgress: MAX_IDENTICAL_NON_PROGRESS - 1,
      evaluation: {
        blocker: GoalBlocker.goal_not_met_yet,
        reasoning: 'x',
      },
    });
    expect(decision.continue).toBe(true);
  });
});
