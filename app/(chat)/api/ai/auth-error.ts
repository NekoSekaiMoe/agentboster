import { AuthError } from '@/lib/auth/access';

/**
 * Convert an AuthError thrown by the session-access asserts
 * (assertCanReadSession / assertCanManageSharedSession) into the JSON
 * error shape this directory's routes already use, carrying the error's
 * intended HTTP status (401/403) instead of letting it escape the
 * handler as an unhandled 500.
 *
 * Returns null for non-AuthError throwables so callers rethrow —
 * unexpected failures (DB errors, etc.) must surface as 5xx, never be
 * mislabeled as auth failures.
 */
export function authErrorResponse(
  error: unknown,
  options: { includeOk: boolean },
): Response | null {
  if (!(error instanceof AuthError)) return null;
  const body = options.includeOk
    ? { ok: false, error: error.message }
    : { error: error.message };
  return Response.json(body, { status: error.status });
}
