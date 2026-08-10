import { requireAuthAccess } from '@/lib/auth/access';
import { assertCanReadSession } from '@/lib/chat/session-access';
import { getSessionByWorkflowRunId } from '@/lib/core/db/chat';
import { createLogger } from '@/lib/utils/logger';
import { resumeLocalToolResult } from '@/lib/workflow/agent/dispatch';
import { cookies } from 'next/headers';
import { z } from 'zod';

const logger = createLogger('api.ai.run.tool-result');

const requestSchema = z.object({
  toolCallId: z.string().min(1),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
});

/**
 * Resume a `local_*` tool execute that is blocked on
 * localToolResultHookBuilder inside the workflow agent loop. Called by
 * the CLI client after it executes a local-tool-request chunk against
 * the user's own filesystem.
 *
 * Security model mirrors the approval resume endpoint:
 *   - Caller must be authenticated (cookie or Bearer).
 *   - Caller's userId must own the session OR share its workspace
 *     (assertCanManageSharedSession).
 *   - The toolCallId is an LLM-generated ULID — unguessable by third
 *     parties — and is the hook resume token. Only the workflow that
 *     emitted it and the CLI that received the request chunk know it.
 *
 * We deliberately do NOT enforce session.channel === 'cli:*' here. The
 * hook resume is a no-op if no local_* tool is awaiting (the hook
 * builder throws on unknown token), so a web client calling this with
 * a random toolCallId simply 500s. No state mutation occurs.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const cookieStore = await cookies();
  let access: Awaited<ReturnType<typeof requireAuthAccess>>;
  try {
    access = await requireAuthAccess(cookieStore);
  } catch {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const session = await getSessionByWorkflowRunId(runId);
  if (!session) {
    return Response.json(
      { ok: false, error: 'Run not found.' },
      { status: 404 },
    );
  }
  await assertCanReadSession(access, session);

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

  try {
    await resumeLocalToolResult(body.toolCallId, {
      ok: body.ok,
      output: body.output,
      error: body.error,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('tool-result:resume_failed', {
      runId,
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
    runId,
    toolCallId: body.toolCallId,
    ok: body.ok,
  });

  return Response.json({ ok: true });
}
