import { describe, expect, it, vi } from 'vitest';
import { executeWhoamiCommand } from './whoami';

vi.mock('@/lib/core/db/users', () => ({
  getUserById: vi.fn(),
}));

vi.mock('@/lib/core/db/im-accounts', () => ({
  getImAccount: vi.fn(),
  listImAccountsForUser: vi.fn(),
}));

import { getUserById } from '@/lib/core/db/users';
import { getImAccount, listImAccountsForUser } from '@/lib/core/db/im-accounts';

const IM_USER_ID = 'telegram:123456789';
const CLAWLESS_USER_ID = 'clawless-uuid-abc';
const ADAPTER = 'telegram';

describe('executeWhoamiCommand', () => {
  it('returns "not bound" when adapter is missing', async () => {
    const text = await executeWhoamiCommand(null, IM_USER_ID);
    expect(text).toBe('Not available outside an IM channel.');
  });

  it('returns "not bound" when imUserId is missing', async () => {
    const text = await executeWhoamiCommand(ADAPTER, null);
    expect(text).toBe('Not available outside an IM channel.');
  });

  it('reports unpaired when no matching IM account exists', async () => {
    vi.mocked(getImAccount).mockResolvedValueOnce(null);
    const text = await executeWhoamiCommand(ADAPTER, IM_USER_ID);
    expect(text).toContain('not bound to any ClawLess user');
    expect(getImAccount).toHaveBeenCalledWith(ADAPTER, IM_USER_ID);
  });

  it('reports unpaired when the IM account was unpaired', async () => {
    vi.mocked(getImAccount).mockResolvedValueOnce({
      id: 'im-rec-1',
      adapter: ADAPTER,
      imUserId: IM_USER_ID,
      clawlessUserId: CLAWLESS_USER_ID,
      pairedAt: new Date(),
      unpairedAt: new Date(),
      imUserName: null,
    });
    const text = await executeWhoamiCommand(ADAPTER, IM_USER_ID);
    expect(text).toContain('not bound to any ClawLess user');
  });

  it('shows the bound ClawLess identity for a paired IM account', async () => {
    vi.mocked(getImAccount).mockResolvedValueOnce({
      id: 'im-rec-1',
      adapter: ADAPTER,
      imUserId: IM_USER_ID,
      clawlessUserId: CLAWLESS_USER_ID,
      pairedAt: new Date(),
      unpairedAt: null,
      imUserName: 'alice',
    });
    vi.mocked(getUserById).mockResolvedValueOnce({
      id: CLAWLESS_USER_ID,
      username: 'alice',
      roles: ['admin'],
    } as never);
    vi.mocked(listImAccountsForUser).mockResolvedValueOnce([
      {
        id: 'im-rec-1',
        adapter: ADAPTER,
        imUserId: IM_USER_ID,
        clawlessUserId: CLAWLESS_USER_ID,
        pairedAt: new Date(),
        unpairedAt: null,
        imUserName: 'alice',
      },
    ]);

    const text = await executeWhoamiCommand(ADAPTER, IM_USER_ID);

    expect(text).toContain('Current ClawLess identity');
    expect(text).toContain(`User ID: ${CLAWLESS_USER_ID}`);
    expect(text).toContain('Username: alice');
    expect(text).toContain(`This IM account: ${ADAPTER}:${IM_USER_ID}`);
    // Regression: caller must pass the raw IM user id, not the resolved
    // ClawLess uuid. If getImAccount receives the ClawLess uuid the lookup
    // returns null and the user is falsely told they are unpaired.
    expect(getImAccount).toHaveBeenCalledWith(ADAPTER, IM_USER_ID);
    expect(getImAccount).not.toHaveBeenCalledWith(ADAPTER, CLAWLESS_USER_ID);
  });
});
