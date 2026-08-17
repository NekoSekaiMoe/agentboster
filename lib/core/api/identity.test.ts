import { describe, expect, it, vi } from 'vitest';

import { fetchIdentity } from './identity';

/**
 * Contract-drift guard for GET /api/auth/me: the fetcher must degrade to
 * the null identity (signed-out shell) instead of throwing when the
 * response is malformed — e.g. an older backend without this endpoint
 * (404 HTML), a proxy error page, or a drifted payload shape.
 */

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })),
  );
}

describe('fetchIdentity', () => {
  it('parses a well-formed identity payload', async () => {
    mockFetchOnce(200, {
      userId: 'u-1',
      username: 'alice',
      isAdmin: true,
    });
    const identity = await fetchIdentity();
    expect(identity).toEqual({
      userId: 'u-1',
      username: 'alice',
      isAdmin: true,
    });
  });

  it('tolerates missing optional fields (older backend)', async () => {
    mockFetchOnce(200, { userId: 'u-1' });
    const identity = await fetchIdentity();
    expect(identity?.userId).toBe('u-1');
    expect(identity?.isAdmin).toBe(false);
  });

  it('returns null on 401', async () => {
    mockFetchOnce(401, { error: 'Unauthorized' });
    expect(await fetchIdentity()).toBeNull();
  });

  it('returns null on a malformed payload instead of throwing', async () => {
    mockFetchOnce(200, { user: 'u-1' });
    expect(await fetchIdentity()).toBeNull();
  });

  it('returns null when the body is not JSON (proxy error page)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      })),
    );
    expect(await fetchIdentity()).toBeNull();
  });
});
