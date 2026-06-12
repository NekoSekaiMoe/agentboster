import { pauseWorkflow } from '@/lib/workflow/agent/dispatch';

export async function executeCancelCommand(input: {
  sessionId: string | null;
  runId: string | null;
}): Promise<{ text: string }> {
  if (!input.sessionId) {
    return { text: '没有活动的会话。' };
  }

  if (!input.runId) {
    return { text: '当前会话没有正在运行的请求。' };
  }

  try {
    await pauseWorkflow(input.runId);
    return { text: '已取消当前请求。' };
  } catch (error) {
    return {
      text: `取消请求失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
