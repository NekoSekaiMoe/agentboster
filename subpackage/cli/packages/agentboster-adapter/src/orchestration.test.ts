import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Tests for the shared orchestration plan client. The fetch logic lives here
// (used by both CLI and Desktop), so this is the canonical test. Mocks
// global fetch + the AgentbosterAuth type; asserts URL construction, headers,
// envelope unpacking, and the throw contract.

import type { AgentbosterAuth } from './auth.ts';
import {
  addRemotePlanItem,
  archiveRemotePlan,
  createRemotePlan,
  getRemotePlan,
  listRemotePlans,
  patchRemotePlan,
  patchRemotePlanItem,
  removeRemotePlanItem,
  submitRemotePlan,
} from './orchestration.ts';

const AUTH: AgentbosterAuth = {
  url: 'https://app.test',
  token: 'tok-1',
  username: 'u',
};
const PLANS_URL =
  'https://app.test/api/cli/sessions/sess-1/orchestration/plans';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetchOnce(response: Response) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
}

describe('orchestration client (shared adapter)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  describe('listRemotePlans', () => {
    it('returns plans on ok envelope', async () => {
      mockFetchOnce(
        jsonResponse({
          ok: true,
          plans: [{ planId: 'p1', title: 'T', items: [] }],
        }),
      );
      const plans = await listRemotePlans(AUTH, 'sess-1');
      expect(plans).toHaveLength(1);
      expect(plans[0].planId).toBe('p1');
      expect(fetch).toHaveBeenCalledWith(PLANS_URL, {
        headers: {
          authorization: 'Bearer tok-1',
          cookie: 'clawless-auth=tok-1',
        },
      });
    });

    it('returns [] on non-ok', async () => {
      mockFetchOnce(new Response('nope', { status: 401 }));
      const plans = await listRemotePlans(AUTH, 'sess-1');
      expect(plans).toEqual([]);
    });

    it('returns [] when plans field absent', async () => {
      mockFetchOnce(jsonResponse({ ok: true }));
      const plans = await listRemotePlans(AUTH, 'sess-1');
      expect(plans).toEqual([]);
    });
  });

  describe('createRemotePlan', () => {
    it('returns plan on success', async () => {
      mockFetchOnce(
        jsonResponse({ ok: true, plan: { planId: 'p1', title: 'T' } }, 201),
      );
      const plan = await createRemotePlan(AUTH, 'sess-1', { title: 'T' });
      expect(plan.planId).toBe('p1');
      expect(fetch).toHaveBeenCalledWith(PLANS_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer tok-1',
          cookie: 'clawless-auth=tok-1',
        },
        body: JSON.stringify({ title: 'T' }),
      });
    });

    it('throws on error envelope', async () => {
      mockFetchOnce(jsonResponse({ ok: false, error: 'bad title' }, 400));
      await expect(createRemotePlan(AUTH, 'sess-1', { title: '' })).rejects.toThrow(
        'bad title',
      );
    });

    it('throws on non-ok with status when error absent', async () => {
      mockFetchOnce(new Response('', { status: 500 }));
      await expect(createRemotePlan(AUTH, 'sess-1', { title: 'x' })).rejects.toThrow(
        'HTTP 500',
      );
    });
  });

  describe('getRemotePlan', () => {
    it('returns plan on ok', async () => {
      mockFetchOnce(
        jsonResponse({ ok: true, plan: { planId: 'p1', items: [] } }),
      );
      const plan = await getRemotePlan(AUTH, 'sess-1', 'p1');
      expect(plan?.planId).toBe('p1');
      expect(fetch).toHaveBeenCalledWith(`${PLANS_URL}/p1`, {
        headers: {
          authorization: 'Bearer tok-1',
          cookie: 'clawless-auth=tok-1',
        },
      });
    });

    it('returns null on non-ok', async () => {
      mockFetchOnce(new Response('', { status: 404 }));
      const plan = await getRemotePlan(AUTH, 'sess-1', 'p1');
      expect(plan).toBeNull();
    });
  });

  describe('patchRemotePlan / archiveRemotePlan', () => {
    it('patch returns updated plan', async () => {
      mockFetchOnce(
        jsonResponse({ ok: true, plan: { planId: 'p1', title: 'new' } }),
      );
      const plan = await patchRemotePlan(AUTH, 'sess-1', 'p1', {
        title: 'new',
      });
      expect(plan?.title).toBe('new');
      expect(fetch).toHaveBeenCalledWith(
        `${PLANS_URL}/p1`,
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    it('archive returns boolean ok', async () => {
      mockFetchOnce(new Response('{}', { status: 200 }));
      const ok = await archiveRemotePlan(AUTH, 'sess-1', 'p1');
      expect(ok).toBe(true);
      expect(fetch).toHaveBeenCalledWith(
        `${PLANS_URL}/p1`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('archive returns false on non-ok', async () => {
      mockFetchOnce(new Response('', { status: 404 }));
      const ok = await archiveRemotePlan(AUTH, 'sess-1', 'p1');
      expect(ok).toBe(false);
    });
  });

  describe('items', () => {
    it('addRemotePlanItem returns item', async () => {
      mockFetchOnce(
        jsonResponse(
          { ok: true, item: { itemId: 'i1', agentName: 'a', task: 't' } },
          201,
        ),
      );
      const item = await addRemotePlanItem(AUTH, 'sess-1', 'p1', {
        agentName: 'a',
        task: 't',
      });
      expect(item.itemId).toBe('i1');
      expect(fetch).toHaveBeenCalledWith(
        `${PLANS_URL}/p1/items`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('addRemotePlanItem throws on error', async () => {
      mockFetchOnce(jsonResponse({ ok: false, error: 'no plan' }, 404));
      await expect(
        addRemotePlanItem(AUTH, 'sess-1', 'p1', {
          agentName: 'a',
          task: 't',
        }),
      ).rejects.toThrow('no plan');
    });

    it('removeRemotePlanItem returns boolean ok', async () => {
      mockFetchOnce(new Response('{}', { status: 200 }));
      const ok = await removeRemotePlanItem(AUTH, 'sess-1', 'p1', 'i1');
      expect(ok).toBe(true);
      expect(fetch).toHaveBeenCalledWith(
        `${PLANS_URL}/p1/items/i1`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('submitRemotePlan', () => {
    it('returns instruction + sessionId', async () => {
      mockFetchOnce(
        jsonResponse({
          ok: true,
          instruction: '# Wave 1\n- agent: a',
          sessionId: 'sess-1',
        }),
      );
      const result = await submitRemotePlan(AUTH, 'sess-1', 'p1');
      expect(result.instruction).toContain('Wave 1');
      expect(result.sessionId).toBe('sess-1');
      expect(fetch).toHaveBeenCalledWith(
        `${PLANS_URL}/p1/submit`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('throws on error envelope', async () => {
      mockFetchOnce(jsonResponse({ ok: false, error: 'empty plan' }, 400));
      await expect(submitRemotePlan(AUTH, 'sess-1', 'p1')).rejects.toThrow(
        'empty plan',
      );
    });

    it('falls back to passed sessionId when response omits it', async () => {
      mockFetchOnce(jsonResponse({ ok: true, instruction: 'do x' }));
      const result = await submitRemotePlan(AUTH, 'sess-1', 'p1');
      expect(result.sessionId).toBe('sess-1');
    });
  });

  it('encodes sessionId in URL path', async () => {
    mockFetchOnce(jsonResponse({ ok: true, plans: [] }));
    await listRemotePlans(AUTH, 'sess with space');
    expect(fetch).toHaveBeenCalledWith(
      'https://app.test/api/cli/sessions/sess%20with%20space/orchestration/plans',
      expect.anything(),
    );
  });
});
