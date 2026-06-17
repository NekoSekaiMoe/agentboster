import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/core/db/users', () => ({
  getUserById: vi.fn(),
  updateUserModelPreferences: vi.fn(),
}));

vi.mock('@/lib/core/kv/config', () => ({
  getConfig: vi.fn(),
  patchConfig: vi.fn(),
}));

import { executeModelCommand } from './model';
import { getUserById, updateUserModelPreferences } from '@/lib/core/db/users';
import { getConfig } from '@/lib/core/kv/config';

const USER_ID = 'user-uuid-1';
const PERSONAL_MODEL = 'claude-sonnet-4';
const GLOBAL_MODEL = 'gpt-4o';

describe('executeModelCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('no args — display effective model', () => {
    it('shows the personal preference when set', async () => {
      vi.mocked(getUserById).mockResolvedValueOnce({
        id: USER_ID,
        username: 'alice',
        roles: ['user'],
        modelPreferences: { model: PERSONAL_MODEL },
        createdAt: new Date(),
      });
      vi.mocked(getConfig).mockResolvedValueOnce({
        models: { model: GLOBAL_MODEL },
      } as never);

      const text = await executeModelCommand('', { userId: USER_ID });

      expect(text).toContain(`Your preferred model: ${PERSONAL_MODEL}`);
      expect(text).toContain(`global default: ${GLOBAL_MODEL}`);
    });

    it('shows the global default when user has no preference', async () => {
      vi.mocked(getUserById).mockResolvedValueOnce({
        id: USER_ID,
        username: 'alice',
        roles: ['user'],
        modelPreferences: null,
        createdAt: new Date(),
      });
      vi.mocked(getConfig).mockResolvedValueOnce({
        models: { model: GLOBAL_MODEL },
      } as never);

      const text = await executeModelCommand('', { userId: USER_ID });

      expect(text).toContain(`global default: ${GLOBAL_MODEL}`);
      expect(text).toContain('/model <name>');
    });

    it('reports "no model" when neither personal nor global is set', async () => {
      vi.mocked(getUserById).mockResolvedValueOnce({
        id: USER_ID,
        username: 'alice',
        roles: ['user'],
        modelPreferences: null,
        createdAt: new Date(),
      });
      vi.mocked(getConfig).mockResolvedValueOnce({
        models: {},
      } as never);

      const text = await executeModelCommand('', { userId: USER_ID });

      expect(text).toContain('No model set');
    });

    it('rejects when no userId is available', async () => {
      const text = await executeModelCommand('', { userId: null });
      expect(text).toBe('Cannot show model: user ID not available.');
    });
  });

  describe('with args — write personal preference', () => {
    it('writes the personal preference via updateUserModelPreferences', async () => {
      vi.mocked(updateUserModelPreferences).mockResolvedValueOnce({
        id: USER_ID,
        username: 'alice',
        roles: ['user'],
        modelPreferences: { model: PERSONAL_MODEL },
        createdAt: new Date(),
      });

      const text = await executeModelCommand(PERSONAL_MODEL, {
        userId: USER_ID,
      });

      expect(updateUserModelPreferences).toHaveBeenCalledWith(USER_ID, {
        model: PERSONAL_MODEL,
      });
      expect(text).toContain(`Your preferred model is now: ${PERSONAL_MODEL}`);
    });

    it('trims whitespace before saving', async () => {
      vi.mocked(updateUserModelPreferences).mockResolvedValueOnce(
        null as never,
      );

      await executeModelCommand(`  ${PERSONAL_MODEL}  `, {
        userId: USER_ID,
      });

      expect(updateUserModelPreferences).toHaveBeenCalledWith(USER_ID, {
        model: PERSONAL_MODEL,
      });
    });

    it('rejects an empty model id', async () => {
      vi.mocked(getUserById).mockResolvedValueOnce({
        id: USER_ID,
        username: 'alice',
        roles: ['user'],
        modelPreferences: null,
        createdAt: new Date(),
      });
      vi.mocked(getConfig).mockResolvedValueOnce({
        models: { model: GLOBAL_MODEL },
      } as never);

      const text = await executeModelCommand('   ', { userId: USER_ID });

      // Empty input falls through to the display branch, not the write branch.
      expect(updateUserModelPreferences).not.toHaveBeenCalled();
      expect(text).toContain('global default');
    });

    it('rejects when no userId is available', async () => {
      const text = await executeModelCommand(PERSONAL_MODEL, { userId: null });
      expect(text).toBe('Cannot set model: user ID not available.');
      expect(updateUserModelPreferences).not.toHaveBeenCalled();
    });

    it('never touches the global config (regression)', async () => {
      vi.mocked(updateUserModelPreferences).mockResolvedValueOnce(
        null as never,
      );

      await executeModelCommand(PERSONAL_MODEL, { userId: USER_ID });

      // The legacy /model wrote config.models.model via patchConfig.
      // The new per-user /model must never do that.
      const { patchConfig } = await import('@/lib/core/kv/config');
      expect(patchConfig).not.toHaveBeenCalled();
    });
  });
});
