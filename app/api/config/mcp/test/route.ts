/**
 * Test connection to a configured MCP server.
 *
 * POST /api/config/mcp/test
 *   body: { serverName: string }
 *
 * Calls tools/list on the server using the current credentials (static
 * headers or OAuth bearer if available) and reports the count of tools
 * exposed. Used by the "Test" button in the config UI.
 *
 * Auth: admin-only.
 */

export const dynamic = 'force-dynamic';

import { requireAdminAccess } from '@/lib/auth/access';
import { getConfig } from '@/lib/core/kv/config';
import { testRemoteMcpServer } from '@/lib/mcp/remote';
import { cookies } from 'next/headers';
import { z } from 'zod';

const requestSchema = z.object({
  serverName: z.string().min(1).max(64),
});

export async function POST(request: Request) {
  const cookieStore = await cookies();
  try {
    await requireAdminAccess(cookieStore);
  } catch (error) {
    const status =
      error instanceof Error && 'status' in error
        ? (error as { status: number }).status
        : 401;
    return Response.json(
      { success: false, error: status === 403 ? 'Forbidden' : 'Unauthorized' },
      { status },
    );
  }

  const body = await request.json().catch(() => ({}));
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { success: false, error: 'Invalid request' },
      { status: 400 },
    );
  }
  const { serverName } = parsed.data;

  const config = await getConfig();
  const serverConfig = config.mcp?.[serverName];
  if (!serverConfig) {
    return Response.json(
      { success: false, error: `Server "${serverName}" not found in config` },
      { status: 404 },
    );
  }

  const result = await testRemoteMcpServer({ serverName, serverConfig });

  if (!result.ok) {
    return Response.json({ success: false, error: result.error });
  }

  return Response.json({
    success: true,
    data: {
      serverName,
      toolCount: result.toolCount,
      sampleToolNames: result.sampleToolNames,
    },
  });
}
