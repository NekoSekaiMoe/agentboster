import {
  getResourceErrorMessage,
  getResourceErrorStatus,
  requireTaskAccess,
  upsertAgentTaskOutput,
} from '@/lib/core/db/agentd';
import { getSession, updateSession } from '@/lib/core/db/chat';
import { createLogger } from '@/lib/utils/logger';
import { NextRequest, NextResponse } from 'next/server';

const logger = createLogger('agentd.stream-output');

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: taskID } = await params;

  let body: {
    task_id?: string;
    session_id?: string;
    output?: string;
    stream_position?: number;
    timestamp?: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const { session_id, output, stream_position } = body;

  if (!session_id || !output) {
    return NextResponse.json(
      { success: false, error: 'session_id and output are required' },
      { status: 400 },
    );
  }

  try {
    await requireTaskAccess({ taskId: taskID, sessionId: session_id });

    // Persist output to database (append-only)
    await upsertAgentTaskOutput({
      taskID,
      sessionID: session_id,
      output,
      streamPosition: stream_position ?? 0,
    });

    // Update session metadata with latest output position
    const session = await getSession(session_id);
    if (session) {
      await updateSession(session_id, {
        metadata: {
          ...(session.metadata as Record<string, unknown> | null),
          latestStreamPosition: stream_position ?? 0,
          lastOutputStreamAt: new Date().toISOString(),
        },
      });
    }

    logger.info('stream output received', {
      task_id: taskID,
      session_id,
      position: stream_position,
      bytes: output.length,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('stream output failed', {
      task_id: taskID,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: getResourceErrorMessage(error) },
      { status: getResourceErrorStatus(error) },
    );
  }
}
