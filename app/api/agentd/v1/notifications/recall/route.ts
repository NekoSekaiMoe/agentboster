export const dynamic = 'force-dynamic';

import { deleteAdapterSourceMessage } from '@/lib/bot/reply';
import { chatSourceSchema } from '@/types/workflow';
import { z } from 'zod';

const requestSchema = z.object({
  source: chatSourceSchema,
  message_id: z.string().trim().min(1),
});

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return Response.json(
      { success: false, error: 'Invalid recall request' },
      { status: 400 },
    );
  }

  const deleted = await deleteAdapterSourceMessage(
    parsed.data.source,
    parsed.data.message_id,
  );

  return Response.json({ success: deleted, data: { deleted } });
}
