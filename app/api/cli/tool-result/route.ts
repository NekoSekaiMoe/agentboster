import {
  assertCanAccessOwnedResource,
  requireAuthAccess,
} from '@/lib/auth/access';
import { getSession } from '@/lib/core/db/chat';
import { createLogger } from '@/lib/utils/logger';
import { resumeLocalToolResult } from '@/lib/workflow/agent/dispatch';
import { cookies } from 'next/headers';
import { z } from 'zod';

const logger = createLogger('api.cli.tool-result');

const requestSchema = z.object({
  sessionId: z.string().min(1),
  toolCallId: z.string().min(1),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
});

/**
 * POST /api/cli/tool-result
 *
 * Resume a `local_*` tool execute that is blocked on
 * localToolResultHookBuilder inside the workflow agent loop. Called by
 * the CLI client after it executes a tool request received via
 * session-events SSE (remote control mode).
 *
 * This is the remote-control counterpart to
 * /api/ai/[runId]/tool-result (which expects runId in path). Here we
 * accept sessionId in the body because the CLI in remote control mode
 * may not have direct access to the runId.
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  let access: Awaited<ReturnType<typeof requireAuthAccess>>;
  try {
    access = await requireAuthAccess(cookieStore);
  } catch {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await request.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        { ok: false, error: 'Invalid payload', details: error.issues },
        { status: 400 },
      );
    }
    return Response.json(
      { ok: false, error: 'Invalid request body.' },
      { status: 400 },
    );
  }

  const session = await getSession(body.sessionId, {
    userId: access.session.userId,
  });
  if (!session) {
    return Response.json(
      { ok: false, error: 'Session not found.' },
      { status: 404 },
    );
  }
  assertCanAccessOwnedResource(access, session.userId);

  try {
    await resumeLocalToolResult(body.toolCallId, {
      ok: body.ok,
      output: body.output,
      error: body.error,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('tool-result:resume_failed', {
      sessionId: body.sessionId,
      toolCallId: body.toolCallId,
      error: message,
    });
    return Response.json(
      {
        ok: false,
        error:
          'Failed to resume tool. The workflow may have moved past this tool call or the run has ended.',
      },
      { status: 409 },
    );
  }

  logger.info('tool-result:resumed', {
    sessionId: body.sessionId,
    toolCallId: body.toolCallId,
    ok: body.ok,
  });

  return Response.json({ ok: true });
}
