import { listSessions } from '@/lib/core/db/chat';
import { withCliAuth } from '@/lib/cli/auth';

/**
 * GET /api/cli/sessions?limit=50&channel=cli:<clientId>
 *
 * Returns the caller's sessions, newest first. Optional `channel` query
 * filters by exact channel match — the CLI passes its own cli:<clientId>
 * to restrict the list to sessions started from this machine.
 */
export const GET = withCliAuth(async (request, { userId }) => {
  const url = new URL(request.url);
  const limit = Math.max(
    1,
    Math.min(Number(url.searchParams.get('limit') ?? '50'), 200),
  );
  const channel = url.searchParams.get('channel') ?? undefined;

  const rows = await listSessions({
    userId,
    archived: false,
    limit,
    channel,
  });

  return Response.json({
    ok: true,
    sessions: rows.map((row) => ({
      id: row.id,
      title: row.title,
      channel: row.channel,
      model: row.model,
      totalTokens: row.totalTokens,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
});
