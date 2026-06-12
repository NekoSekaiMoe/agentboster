import { updateSession } from '@/lib/core/db/chat';

export async function executeModelsCommand(input: {
  args: string;
  sessionId: string | null;
}): Promise<{ text: string }> {
  const trimmedArgs = input.args.trim();

  if (!trimmedArgs) {
    return {
      text: '用法: /models provider/model\n例如: /models anthropic/claude-opus-4',
    };
  }

  if (!input.sessionId) {
    return { text: '没有活动的会话。' };
  }

  const parts = trimmedArgs.split('/');
  if (parts.length !== 2) {
    return {
      text: '格式错误。用法: /models provider/model\n例如: /models anthropic/claude-opus-4',
    };
  }

  const [provider, model] = parts;

  try {
    await updateSession(input.sessionId, {
      metadata: {
        overrideProvider: provider,
        overrideModel: model,
      },
    });

    return { text: `已切换到 ${provider}/${model}` };
  } catch (error) {
    return {
      text: `切换模型失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
