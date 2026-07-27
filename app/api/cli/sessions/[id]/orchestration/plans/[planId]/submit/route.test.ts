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

// DAL stubs for the submit path: assertCanAccessPlan (ownership),
// getPlan (returns the plan with items), synthesizePlanInstruction (pure),
// markPlanSubmitted (DB write).
// biome-ignore lint/suspicious/noExplicitAny: mock signature is intentionally permissive
const assertCanAccessPlanMock = vi.fn<any>(async () => undefined);
// biome-ignore lint/suspicious/noExplicitAny: mock signature is intentionally permissive
const markPlanSubmittedMock = vi.fn<any>(async () => undefined);
let mockPlan: {
  id: string;
  planId: string;
  sessionId: string;
  title: string;
  description: string | null;
  status: 'draft';
  submittedMessageId: null;
  createdAt: Date;
  updatedAt: Date;
  items: Array<{ itemId: string; agentName: string; task: string }>;
} | null = {
  id: 'pk-1',
  planId: 'plan-1',
  sessionId: 'sess-1',
  title: 'demo',
  description: null,
  status: 'draft',
  submittedMessageId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  items: [
    { itemId: 'item-1', agentName: 'researcher', task: 'find sources' },
    { itemId: 'item-2', agentName: 'writer', task: 'draft report' },
  ],
};
// biome-ignore lint/suspicious/noExplicitAny: mock signature is intentionally permissive
const getPlanMock = vi.fn<any>(async () => mockPlan);
vi.mock('@/lib/core/db/agent-orchestration-plans', () => ({
  assertCanAccessPlan: (...args: unknown[]) => assertCanAccessPlanMock(...args),
  getPlan: (...args: unknown[]) => getPlanMock(...args),
  synthesizePlanInstruction: (plan: unknown) =>
    `INSTRUCTION for ${(plan as { title: string }).title}`,
  markPlanSubmitted: (...args: unknown[]) => markPlanSubmittedMock(...args),
}));

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── Helper ───────────────────────────────────────────────────────────

function submitRequest(
  sessionId = 'sess-1',
  planId = 'plan-1',
  body: unknown = {},
): Request {
  return new Request(
    `http://localhost/api/cli/sessions/${sessionId}/orchestration/plans/${planId}/submit`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

// ── Tests ────────────────────────────────────────────────────────────

describe('POST /api/cli/sessions/:id/orchestration/plans/:planId/submit', () => {
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockUserId = 'user-1';
    mockSession = { id: 'sess-1', userId: 'user-1' };
    mockPlan = {
      id: 'pk-1',
      planId: 'plan-1',
      sessionId: 'sess-1',
      title: 'demo',
      description: null,
      status: 'draft',
      submittedMessageId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [
        { itemId: 'item-1', agentName: 'researcher', task: 'find sources' },
      ],
    };
    ({ POST } = await import('./route'));
  });
  afterEach(() => vi.restoreAllMocks());

  it('synthesizes instruction, marks submitted, returns instruction', async () => {
    const res = await POST(submitRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.instruction).toBe('INSTRUCTION for demo');
    expect(json.sessionId).toBe('sess-1');
    expect(markPlanSubmittedMock).toHaveBeenCalledWith('plan-1', '');
    expect(assertCanAccessPlanMock).toHaveBeenCalledWith('plan-1', 'sess-1');
  });

  it('passes through submittedMessageId when provided', async () => {
    await POST(
      submitRequest('sess-1', 'plan-1', { submittedMessageId: 'msg-9' }),
    );
    expect(markPlanSubmittedMock).toHaveBeenCalledWith('plan-1', 'msg-9');
  });

  it('returns 404 when session belongs to another user', async () => {
    mockSession = { id: 'sess-1', userId: 'other' };
    const res = await POST(submitRequest());
    expect(res.status).toBe(404);
    expect(markPlanSubmittedMock).not.toHaveBeenCalled();
  });

  it('returns 404 when plan does not belong to the session', async () => {
    assertCanAccessPlanMock.mockRejectedValue(new Error('mismatch'));
    const res = await POST(submitRequest());
    expect(res.status).toBe(404);
    expect(markPlanSubmittedMock).not.toHaveBeenCalled();
  });

  it('returns 404 when plan is missing', async () => {
    mockPlan = null;
    const res = await POST(submitRequest());
    expect(res.status).toBe(404);
    expect(markPlanSubmittedMock).not.toHaveBeenCalled();
  });

  it('returns 400 when plan has no items', async () => {
    mockPlan = {
      // biome-ignore lint/style/noNonNullAssertion: mockPlan is reset by beforeEach before this test
      ...mockPlan!,
      items: [],
    };
    const res = await POST(submitRequest());
    expect(res.status).toBe(400);
    expect(markPlanSubmittedMock).not.toHaveBeenCalled();
  });

  it('returns 400 when url is missing planId', async () => {
    const req = new Request(
      'http://localhost/api/cli/sessions/sess-1/orchestration/plans//submit',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(markPlanSubmittedMock).not.toHaveBeenCalled();
  });
});
