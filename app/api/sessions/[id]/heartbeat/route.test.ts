import { beforeEach, describe, expect, it, vi } from 'vitest';

const { AuthError, mocks } = vi.hoisted(() => {
  class TestAuthError extends Error {
    readonly status: number;

    constructor(message: 'Unauthorized' | 'Forbidden', status: number) {
      super(message);
      this.name = 'AuthError';
      this.status = status;
    }
  }

  return {
    AuthError: TestAuthError,
    mocks: {
      requireAuthAccess: vi.fn(),
      getSession: vi.fn(),
      getSessionHeartbeat: vi.fn(),
      upsertSessionHeartbeat: vi.fn(),
      ensureHeartbeatWorkflow: vi.fn(),
    },
  };
});

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({})),
}));

vi.mock('@/lib/auth/access', () => ({
  AuthError,
  assertCanAccessOwnedResource: (
    access: { isAdmin: boolean; session: { userId: string } },
    ownerUserId: string | null,
  ) => {
    if (!access.isAdmin && ownerUserId !== access.session.userId) {
      throw new AuthError('Forbidden', 403);
    }
  },
  requireAuthAccess: mocks.requireAuthAccess,
}));

vi.mock('@/lib/core/db/chat', () => ({
  getSession: mocks.getSession,
}));

vi.mock('@/lib/core/db/heartbeat', () => ({
  HEARTBEAT_DEFAULT_INTERVAL_MINUTES: 30,
  HEARTBEAT_MIN_INTERVAL_MINUTES: 5,
  HEARTBEAT_MAX_INTERVAL_MINUTES: 1440,
  MAX_HEARTBEAT_FAILURES: 3,
  clampHeartbeatIntervalMinutes: () => 30,
  getSessionHeartbeat: mocks.getSessionHeartbeat,
  upsertSessionHeartbeat: mocks.upsertSessionHeartbeat,
}));

vi.mock('@/lib/workflow/scheduled/heartbeat-dispatch', () => ({
  ensureHeartbeatWorkflow: mocks.ensureHeartbeatWorkflow,
}));

import { GET, PUT } from './route';

const params = Promise.resolve({ id: 'sess-1' });
const request = (body?: string) =>
  new Request('http://localhost/api/sessions/sess-1/heartbeat', {
    method: 'PUT',
    ...(body === undefined ? {} : { body }),
    headers: { 'content-type': 'application/json' },
  });

describe('heartbeat route auth (CodeRabbit #1: AuthError must not 500)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthAccess.mockResolvedValue({
      session: { userId: 'user-1' },
      isAdmin: false,
    });
    mocks.getSession.mockResolvedValue({
      userId: 'user-other',
      channel: 'telegram',
    });
  });

  it('GET converts an ownership failure into a 403 response', async () => {
    const response = await GET(new Request('http://localhost/x'), { params });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
  });

  it('PUT converts an ownership failure into a 403 response', async () => {
    const response = await PUT(request('{"enabled": true}'), { params });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
    expect(mocks.upsertSessionHeartbeat).not.toHaveBeenCalled();
  });

  it('GET serves the owner normally', async () => {
    mocks.getSession.mockResolvedValue({
      userId: 'user-1',
      channel: 'telegram',
    });
    mocks.getSessionHeartbeat.mockResolvedValue(null);

    const response = await GET(new Request('http://localhost/x'), { params });
    expect(response.status).toBe(200);
  });
});

describe('heartbeat route PUT body validation (CodeRabbit #2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthAccess.mockResolvedValue({
      session: { userId: 'user-1' },
      isAdmin: false,
    });
    mocks.getSession.mockResolvedValue({
      userId: 'user-1',
      channel: 'telegram',
    });
    mocks.getSessionHeartbeat.mockResolvedValue(null);
    mocks.upsertSessionHeartbeat.mockResolvedValue({
      enabled: true,
      intervalMinutes: 30,
      nextRunAt: null,
    });
    mocks.ensureHeartbeatWorkflow.mockResolvedValue('run-1');
  });

  it('rejects a null body with 400 instead of crashing with 500', async () => {
    const response = await PUT(request('null'), { params });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Request body must be an object.',
    });
    expect(mocks.upsertSessionHeartbeat).not.toHaveBeenCalled();
  });

  it('rejects an array body with 400', async () => {
    const response = await PUT(request('[1,2,3]'), { params });

    expect(response.status).toBe(400);
    expect(mocks.upsertSessionHeartbeat).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON with the existing 400', async () => {
    const response = await PUT(request('{not json'), { params });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body.' });
  });

  it('rejects a non-boolean enabled with 400', async () => {
    const response = await PUT(request('{"enabled": "yes"}'), { params });

    expect(response.status).toBe(400);
    expect(mocks.upsertSessionHeartbeat).not.toHaveBeenCalled();
  });

  it('enables and arms the wake loop on a valid body', async () => {
    const response = await PUT(request('{"enabled": true}'), { params });

    expect(response.status).toBe(200);
    expect(mocks.upsertSessionHeartbeat).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      enabled: true,
      intervalMinutes: 30,
    });
    expect(mocks.ensureHeartbeatWorkflow).toHaveBeenCalledWith('sess-1');
  });
});
