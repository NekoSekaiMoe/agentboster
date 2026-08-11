/**
 * Tests for readItemError (lib/core/api/workspaces.ts).
 *
 * The helper parses a failed mutation's body for the server's structured
 * `error` string and must fall back to the caller's generic message in
 * every drift scenario — installed clients talk to newer backends, so a
 * malformed body must never surface as `undefined` or a thrown parse
 * error.
 */

import { describe, expect, it } from 'vitest';

import { readItemError } from '@/lib/core/api/workspaces';

function fakeResponse(body: unknown): Response {
  return {
    json: async () => body,
  } as Response;
}

const FALLBACK = 'Failed to rename workspace';

describe('readItemError', () => {
  it('uses the server-provided error message when present', async () => {
    const error = await readItemError(
      fakeResponse({ success: false, data: null, error: 'Name taken' }),
      FALLBACK,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Name taken');
  });

  it('falls back when the body is not valid JSON', async () => {
    const res = {
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    } as unknown as Response;
    const error = await readItemError(res, FALLBACK);
    expect(error.message).toBe(FALLBACK);
  });

  it('falls back when payload.data is null and no error is given', async () => {
    const error = await readItemError(
      fakeResponse({ success: false, data: null }),
      FALLBACK,
    );
    expect(error.message).toBe(FALLBACK);
  });

  it('falls back when the error field is missing', async () => {
    const error = await readItemError(
      fakeResponse({ success: false }),
      FALLBACK,
    );
    expect(error.message).toBe(FALLBACK);
  });

  it('falls back when the payload drifts from the schema entirely', async () => {
    const error = await readItemError(
      fakeResponse('<html>502</html>'),
      FALLBACK,
    );
    expect(error.message).toBe(FALLBACK);
  });
});
