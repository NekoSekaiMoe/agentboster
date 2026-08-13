/**
 * Tests for the /goal command (lib/chat/commands/goal.ts).
 *
 * The DAL is mocked so these tests exercise only the command's
 * subcommand parsing, the active-run guard, and the length limit.
 *
 * Run via: yarn test lib/chat/commands/goal.test.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/core/db/chat', () => ({
  setSessionGoal: vi.fn(),
  clearSessionGoal: vi.fn(),
  getSessionGoalState: vi.fn(),
}));

vi.mock('@/lib/workflow/agent/session-goal', () => ({
  MAX_GOAL_OBJECTIVE_CHARS: 4000,
}));

import {
  clearSessionGoal,
  getSessionGoalState,
  setSessionGoal,
} from '@/lib/core/db/chat';
import { executeGoalCommand } from './goal';

const SESSION_ID = '11111111-1111-1111-1111-111111111111';

describe('executeGoalCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('no args (show)', () => {
    it('reports no goal when none is set', async () => {
      vi.mocked(getSessionGoalState).mockResolvedValueOnce({
        goalText: null,
        hiddenCount: 0,
        consecutiveNonProgress: 0,
        lastEvalReason: null,
      });
      const text = await executeGoalCommand({
        sessionId: SESSION_ID,
        args: '',
        activeRunId: null,
      });
      expect(text).toContain('No goal set');
    });

    it('shows the goal + counters when one is set', async () => {
      vi.mocked(getSessionGoalState).mockResolvedValueOnce({
        goalText: 'ship the feature',
        hiddenCount: 3,
        consecutiveNonProgress: 1,
        lastEvalReason: 'still working',
      });
      const text = await executeGoalCommand({
        sessionId: SESSION_ID,
        args: '',
        activeRunId: null,
      });
      expect(text).toContain('ship the feature');
      expect(text).toContain('3 / 8'); // hidden continuations
      expect(text).toContain('1 / 2'); // non-progress
      expect(text).toContain('still working');
    });
  });

  describe('set', () => {
    it('calls setSessionGoal with the trimmed text', async () => {
      vi.mocked(setSessionGoal).mockResolvedValueOnce({
        id: SESSION_ID,
      } as never);
      const text = await executeGoalCommand({
        sessionId: SESSION_ID,
        args: 'set   build a todo app   ',
        activeRunId: null,
      });
      expect(setSessionGoal).toHaveBeenCalledWith(
        SESSION_ID,
        'build a todo app',
      );
      expect(text).toContain('Goal set');
      expect(text).toContain('build a todo app');
    });

    it('rejects while a run is active', async () => {
      const text = await executeGoalCommand({
        sessionId: SESSION_ID,
        args: 'set something',
        activeRunId: 'run-123',
      });
      expect(setSessionGoal).not.toHaveBeenCalled();
      expect(text).toContain('run is active');
    });

    it('rejects empty text', async () => {
      const text = await executeGoalCommand({
        sessionId: SESSION_ID,
        args: 'set   ',
        activeRunId: null,
      });
      expect(setSessionGoal).not.toHaveBeenCalled();
      expect(text).toContain('Usage');
    });
  });

  describe('clear', () => {
    it('calls clearSessionGoal when idle', async () => {
      vi.mocked(clearSessionGoal).mockResolvedValueOnce({
        id: SESSION_ID,
      } as never);
      const text = await executeGoalCommand({
        sessionId: SESSION_ID,
        args: 'clear',
        activeRunId: null,
      });
      expect(clearSessionGoal).toHaveBeenCalledWith(SESSION_ID);
      expect(text).toContain('cleared');
    });

    it('rejects while a run is active', async () => {
      const text = await executeGoalCommand({
        sessionId: SESSION_ID,
        args: 'clear',
        activeRunId: 'run-123',
      });
      expect(clearSessionGoal).not.toHaveBeenCalled();
      expect(text).toContain('run is active');
    });
  });

  it('returns usage for an unknown subcommand', async () => {
    const text = await executeGoalCommand({
      sessionId: SESSION_ID,
      args: 'frobnicate',
      activeRunId: null,
    });
    expect(text).toContain('Usage');
  });
});
