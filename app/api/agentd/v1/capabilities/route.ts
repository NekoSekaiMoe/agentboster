import { getBotCapabilities } from '@/lib/bot/adaptor';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const adapter = searchParams.get('adapter') ?? '';
  const chatId = searchParams.get('chatId') ?? '';
  const threadId = searchParams.get('threadId') ?? chatId;

  return Response.json({
    success: true,
    data: {
      adapter,
      chat_id: chatId,
      thread_id: threadId,
      capabilities: getBotCapabilities(adapter),
    },
  });
}
