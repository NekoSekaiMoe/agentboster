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
      listTraces: vi.fn(),
      getTrace: vi.fn(),
      getRun: vi.fn(),
      loggerError: vi.fn(),
    },
  };
});

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({})),
}));

vi.mock('workflow/api', () => ({
  getRun: mocks.getRun,
}));

vi.mock('@/lib/auth/access', () => ({
  AuthError,
  requireAuthAccess: mocks.requireAuthAccess,
}));

vi.mock('@/lib/core/trace/query', () => ({
  listTraces: mocks.listTraces,
  getTrace: mocks.getTrace,
}));

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    error: mocks.loggerError,
  }),
}));

import { GET as getTraceDetail } from './[traceId]/route';
import { GET as listTraceSummaries } from './route';

const access = {
  session: { userId: 'user-1' },
  user: { id: 'user-1' },
  isAdmin: false,
};

describe('trace route error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthAccess.mockResolvedValue(access);
    mocks.listTraces.mockResolvedValue([]);
    mocks.getTrace.mockResolvedValue(null);
    mocks.getRun.mockReturnValue({ status: Promise.resolve('completed') });
  });

  it('returns AuthError status for the trace list without logging it', async () => {
    mocks.requireAuthAccess.mockRejectedValue(
      new AuthError('Unauthorized', 401),
    );

    const response = await listTraceSummaries(
      new Request('http://localhost/api/config/traces'),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'Unauthorized',
    });
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it('preserves a generic database failure as a logged 500 for the trace list', async () => {
    mocks.listTraces.mockRejectedValue(new Error('database unavailable'));

    const response = await listTraceSummaries(
      new Request('http://localhost/api/config/traces'),
    );

    expect(response.status).toBe(500);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      'trace list failed',
      expect.objectContaining({ error: 'database unavailable' }),
    );
  });

  it('preserves AuthError status for trace detail, including 403', async () => {
    mocks.requireAuthAccess.mockRejectedValue(new AuthError('Forbidden', 403));

    const response = await getTraceDetail(new Request('http://localhost'), {
      params: Promise.resolve({ traceId: 'run-1' }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'Forbidden',
    });
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it('preserves a generic database failure as a logged 500 for trace detail', async () => {
    mocks.getTrace.mockRejectedValue(new Error('database unavailable'));

    const response = await getTraceDetail(new Request('http://localhost'), {
      params: Promise.resolve({ traceId: 'run-1' }),
    });

    expect(response.status).toBe(500);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      'trace detail failed',
      expect.objectContaining({ error: 'database unavailable' }),
    );
  });
});
