import { db } from '@/lib/core/db';
import { eq } from 'drizzle-orm';
import { agentReviewLogs } from '@/lib/core/db/schema';

export async function executeResetCommand(input: {
  sessionId: string | null;
}): Promise<{ text: string }> {
  if (!input.sessionId) {
    return { text: '没有活动的会话。' };
  }

  try {
    // Clear any pending L2 authorization decisions for this session
    // This resets the approval/rejection memory similar to manboster's ignorance.Clear
    await db
      .delete(agentReviewLogs)
      .where(eq(agentReviewLogs.decision, 'pending_l2'));

    return { text: '已重置会话状态，清除所有待审批决策。' };
  } catch (error) {
    return {
      text: `重置失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
