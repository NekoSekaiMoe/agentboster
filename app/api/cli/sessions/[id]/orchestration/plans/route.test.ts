import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────
// Mock withCliAuth to bypass all token/device logic and inject a fixed
// userId. The orchestration routes only use ctx.userId from withCliAuth,
// so this is the cleanest seam (per app/api/import/route.test.ts pattern).

let mockUserId = 'user-1';
vi.mock('@/lib/cli/auth', () => ({
  withCliAuth:
    (handler: (req: Request, ctx: { userId: string }) => unknown) =>
    (req: Request) =>
      handler(req, { userId: mockUserId }),
}));

// Session ownership check: getSession({ userId }) drives the 404 path.
let mockSession: { id: string; userId: string } | null = {
  id: 'sess-1',
  userId: 'user-1',
};
const getSessionMock = vi.fn(async () => mockSession);
vi.mock('@/lib/core/db/chat', () => ({
  getSession: () => getSessionMock(),
}));

// DAL — stub each function the routes call, so we assert the route wires
// inputs correctly without hitting Postgres.
// biome-ignore lint/suspicious/noExplicitAny: mock signature is intentionally permissive
const createPlanMock = vi.fn<any>(async () => ({
  id: 'pk-1',
  planId: 'plan-1',
  sessionId: 'sess-1',
  title: 'T',
  description: null,
  status: 'draft' as const,
  submittedMessageId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}));
// biome-ignore lint/suspicious/noExplicitAny: mock signature is intentionally permissive
const listPlansBySessionMock = vi.fn<any>(async () => []);
vi.mock('@/lib/core/db/agent-orchestration-plans', () => ({
  createPlan: (input: unknown) => createPlanMock(input),
  listPlansBySession: (sessionId: string) => listPlansBySessionMock(sessionId),
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

function plansUrl(sessionId = 'sess-1'): string {
  return `http://localhost/api/cli/sessions/${sessionId}/orchestration/plans`;
}

function plansRequest(
  body?: unknown,
  method = 'POST',
  sessionId = 'sess-1',
): Request {
  return new Request(plansUrl(sessionId), {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('GET /api/cli/sessions/:id/orchestration/plans', () => {
  let GET: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockUserId = 'user-1';
    mockSession = { id: 'sess-1', userId: 'user-1' };
    listPlansBySessionMock.mockResolvedValue([
      {
        id: 'pk-1',
        planId: 'plan-1',
        sessionId: 'sess-1',
        title: 'demo',
        description: null,
        status: 'draft',
        submittedMessageId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    ({ GET } = await import('./route'));
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists plans for an owned session', async () => {
    const res = await GET(plansRequest(undefined, 'GET'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.plans).toHaveLength(1);
    expect(json.plans[0].planId).toBe('plan-1');
    expect(listPlansBySessionMock).toHaveBeenCalledWith('sess-1');
  });

  it('returns 404 when session belongs to another user', async () => {
    mockSession = { id: 'sess-1', userId: 'other-user' };
    const res = await GET(plansRequest(undefined, 'GET'));
    expect(res.status).toBe(404);
    expect(listPlansBySessionMock).not.toHaveBeenCalled();
  });

  it('returns 404 when session does not exist', async () => {
    mockSession = null;
    const res = await GET(plansRequest(undefined, 'GET'));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/cli/sessions/:id/orchestration/plans', () => {
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockUserId = 'user-1';
    mockSession = { id: 'sess-1', userId: 'user-1' };
    ({ POST } = await import('./route'));
  });
  afterEach(() => vi.restoreAllMocks());

  it('creates a plan and returns 201', async () => {
    const res = await POST(plansRequest({ title: 'My plan' }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.plan.planId).toBe('plan-1');
    expect(createPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        title: 'My plan',
        description: null,
      }),
    );
  });

  it('accepts a description', async () => {
    await POST(plansRequest({ title: 'T', description: 'desc' }));
    expect(createPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'desc' }),
    );
  });

  it('rejects missing title', async () => {
    const res = await POST(plansRequest({ description: 'no title' }));
    expect(res.status).toBe(400);
    expect(createPlanMock).not.toHaveBeenCalled();
  });

  it('rejects empty-string title', async () => {
    const res = await POST(plansRequest({ title: '   ' }));
    expect(res.status).toBe(400);
    expect(createPlanMock).not.toHaveBeenCalled();
  });

  it('rejects non-string title', async () => {
    const res = await POST(plansRequest({ title: 123 }));
    expect(res.status).toBe(400);
    expect(createPlanMock).not.toHaveBeenCalled();
  });

  it('rejects null body', async () => {
    const req = new Request(plansUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(createPlanMock).not.toHaveBeenCalled();
  });

  it('returns 404 when session belongs to another user', async () => {
    mockSession = { id: 'sess-1', userId: 'other' };
    const res = await POST(plansRequest({ title: 'T' }));
    expect(res.status).toBe(404);
    expect(createPlanMock).not.toHaveBeenCalled();
  });
});
