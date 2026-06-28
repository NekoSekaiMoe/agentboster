import { withCliAuth } from '@/lib/cli/auth';
import { getUserById, updateUserModelPreferences } from '@/lib/core/db/users';
import type { UserModelPreferences } from '@/types/config/user-preferences';

/**
 * GET /api/cli/preferences
 *
 * Returns the caller's model preferences (default model + default
 * thinking level). The CLI reads this at startup to pick its initial
 * model, instead of storing the choice in ~/.agentboster/settings.json.
 * The same blob drives the web chat's per-user default, so the two
 * surfaces stay in sync: change it from the terminal and the next
 * web chat picks it up, and vice versa.
 */
export const GET = withCliAuth(async (_request, { userId }) => {
  const user = await getUserById(userId);
  const preferences = user?.modelPreferences ?? null;
  return Response.json({ ok: true, preferences });
});

type PatchBody = {
  model?: string | null;
  thinkingLevel?: UserModelPreferences['thinkingLevel'] | null;
};

const VALID_THINKING_LEVELS = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

/**
 * PATCH /api/cli/preferences
 *
 * Merge-patch the caller's model preferences. Send `{model: null}` /
 * `{thinkingLevel: null}` to clear a field; omit a field to leave it
 * unchanged. Empty body is a no-op that simply returns the current
 * state.
 */
export const PATCH = withCliAuth(async (request, { userId }) => {
  const body = (await request.json().catch(() => ({}))) as PatchBody;

  const user = await getUserById(userId);
  if (!user) {
    return Response.json(
      { ok: false, error: 'User not found.' },
      { status: 404 },
    );
  }

  const next: UserModelPreferences = {
    ...(user.modelPreferences ?? {}),
  };

  if (body.model !== undefined) {
    next.model = typeof body.model === 'string' ? body.model : undefined;
  }
  if (body.thinkingLevel !== undefined) {
    if (
      body.thinkingLevel === null ||
      !VALID_THINKING_LEVELS.has(body.thinkingLevel)
    ) {
      next.thinkingLevel = undefined;
    } else {
      next.thinkingLevel = body.thinkingLevel;
    }
  }

  const updated = await updateUserModelPreferences(userId, next);
  return Response.json({
    ok: true,
    preferences: updated?.modelPreferences ?? null,
  });
});
