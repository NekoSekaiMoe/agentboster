import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────
let mockUserId = 'user-1';
vi.mock('@/lib/cli/auth', () => ({
  withCliAuth:
    (handler: (req: Request, ctx: { userId: string }) => unknown) =>
    (req: Request) =>
      handler(req, { userId: mockUserId }),
}));

let mockSession: { id: string; userId: string } | null = {
  id: 'sess-1',
  userId: 'user-1',
};
const getSessionMock = vi.fn(async () => mockSession);
vi.mock('@/lib/core/db/chat', () => ({
  getSession: () => getSessionMock(),
}));

const assertCanAccessPlanMock = vi.fn<any>(async () => undefined);
const addPlanItemMock = vi.fn<any>(async () => ({
  id: 'item-pk-1',
  planId: 'plan-pk-uuid',
  itemId: 'item-1',
  agentName: 'researcher',
  task: 'find sources',
  dependsOn: [],
  order: 0,
  removed: false,
  createdAt: new Date(),
  updatedAt: new Date(),
}));
const updatePlanItemMock = vi.fn<any>(async () => ({
  id: 'item-pk-1',
  planId: 'plan-pk-uuid',
  itemId: 'item-1',
  agentName: 'writer',
  task: 'draft',
  dependsOn: [],
  order: 0,
  removed: false,
  createdAt: new Date(),
  updatedAt: new Date(),
}));
const removePlanItemMock = vi.fn<any>(async () => undefined);
vi.mock('@/lib/core/db/agent-orchestration-plans', () => ({
  assertCanAccessPlan: (...args: unknown[]) => assertCanAccessPlanMock(...args),
  addPlanItem: (...args: unknown[]) => addPlanItemMock(...args),
  updatePlanItem: (...args: unknown[]) => updatePlanItemMock(...args),
  removePlanItem: (...args: unknown[]) => removePlanItemMock(...args),
}));

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────

function itemsUrl(planId = 'plan-1', itemId?: string, sessionId = 'sess-1') {
  const base = `http://localhost/api/cli/sessions/${sessionId}/orchestration/plans/${planId}/items`;
  return itemId ? `${base}/${itemId}` : base;
}

function itemsRequest(
  method: string,
  body?: unknown,
  planId = 'plan-1',
  itemId?: string,
): Request {
  return new Request(itemsUrl(planId, itemId), {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('plan items API', () => {
  let POST: (req: Request) => Promise<Response>;
  let PATCH: (req: Request) => Promise<Response>;
  let DELETE: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockUserId = 'user-1';
    mockSession = { id: 'sess-1', userId: 'user-1' };
    ({ POST, PATCH, DELETE } = await import('./route'));
  });
  afterEach(() => vi.restoreAllMocks());

  describe('POST (add item)', () => {
    it('adds an item and returns 201', async () => {
      const res = await POST(
        itemsRequest('POST', { agentName: 'researcher', task: 'find' }),
      );
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.item.itemId).toBe('item-1');
      expect(addPlanItemMock).toHaveBeenCalledWith(
        expect.objectContaining({
          planId: 'plan-1',
          agentName: 'researcher',
          task: 'find',
        }),
      );
    });

    it('passes through dependsOn + order when valid', async () => {
      await POST(
        itemsRequest('POST', {
          agentName: 'a',
          task: 't',
          dependsOn: ['item-0'],
          order: 3,
        }),
      );
      expect(addPlanItemMock).toHaveBeenCalledWith(
        expect.objectContaining({
          dependsOn: ['item-0'],
          order: 3,
        }),
      );
    });

    it('rejects missing agentName', async () => {
      const res = await POST(itemsRequest('POST', { task: 't' }));
      expect(res.status).toBe(400);
      expect(addPlanItemMock).not.toHaveBeenCalled();
    });

    it('rejects missing task', async () => {
      const res = await POST(itemsRequest('POST', { agentName: 'a' }));
      expect(res.status).toBe(400);
      expect(addPlanItemMock).not.toHaveBeenCalled();
    });

    it('returns 404 when session owned by another user', async () => {
      mockSession = { id: 'sess-1', userId: 'other' };
      const res = await POST(
        itemsRequest('POST', { agentName: 'a', task: 't' }),
      );
      expect(res.status).toBe(404);
      expect(addPlanItemMock).not.toHaveBeenCalled();
    });
  });

  describe('PATCH (update item)', () => {
    it('updates and returns the item', async () => {
      const res = await PATCH(
        itemsRequest('PATCH', { task: 'draft' }, 'plan-1', 'item-1'),
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.item.task).toBe('draft');
      expect(updatePlanItemMock).toHaveBeenCalledWith(
        'item-1',
        'plan-1',
        expect.objectContaining({ task: 'draft' }),
      );
    });

    it('rejects empty patch', async () => {
      const res = await PATCH(itemsRequest('PATCH', {}, 'plan-1', 'item-1'));
      expect(res.status).toBe(400);
      expect(updatePlanItemMock).not.toHaveBeenCalled();
    });

    it('returns 404 when update matches no row', async () => {
      updatePlanItemMock.mockResolvedValue(null);
      const res = await PATCH(
        itemsRequest('PATCH', { task: 'x' }, 'plan-1', 'item-1'),
      );
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE (remove item)', () => {
    it('soft-removes the item', async () => {
      const res = await DELETE(
        itemsRequest('DELETE', undefined, 'plan-1', 'item-1'),
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(removePlanItemMock).toHaveBeenCalledWith('item-1', 'plan-1');
    });

    it('returns 404 when session owned by another user', async () => {
      mockSession = { id: 'sess-1', userId: 'other' };
      const res = await DELETE(
        itemsRequest('DELETE', undefined, 'plan-1', 'item-1'),
      );
      expect(res.status).toBe(404);
      expect(removePlanItemMock).not.toHaveBeenCalled();
    });
  });
});
