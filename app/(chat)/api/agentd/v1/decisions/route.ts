import { createLogger } from '@/lib/utils/logger';
import { getNotificationManager } from '@/lib/extra/channels/notification-manager';
import { getKV } from '@/lib/core/kv';

const logger = createLogger('api.agentd.decisions');

/**
 * GET /api/agentd/v1/decisions
 * Returns all pending (sent but unresolved) decisions for the user.
 * Used by the /decisions IM command and Web UI.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');

    if (!userId) {
      return Response.json(
        { success: false, error: 'Missing userId' },
        { status: 400 },
      );
    }

    const kv = getKV();
    const mgr = getNotificationManager();

    // Mark user as online
    await mgr.markUserOnline(userId);

    // Get all pending decisions from KV
    // We store decisions with key pattern l2:decision:{decisionId}:data
    // For now, return from the notification manager's in-memory context
    const decisions: Array<{
      decisionId: string;
      taskId: string;
      command: string;
      score: number;
      reason: string;
      createdAt: string;
      expiresAt: string;
      status: string;
    }> = [];

    // Collect from KV all decisions that are in "sent" state
    // This is a simplified approach — in production you'd query by user
    const sentDecisions = await getSentDecisionsFromKV(kv);

    return Response.json({
      success: true,
      data: {
        decisions: sentDecisions,
        count: sentDecisions.length,
      },
    });
  } catch (error) {
    logger.error('Failed to list decisions', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Failed to list decisions' },
      { status: 500 },
    );
  }
}

async function getSentDecisionsFromKV(kv: ReturnType<typeof getKV>) {
  if (!kv) return [];

  // In a real implementation, you'd maintain an index of pending decisions per user
  // For now, return empty — the Go daemon's decision queue is the source of truth
  // and the Web UI queries it via the Go daemon's GET /api/v1/decisions endpoint
  return [];
}
