import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import { DEFAULT_MODEL_NAME, models } from '@/lib/ai/models';
import { getSessionById } from '@/app/(chat)/actions';
import { Chat } from '@/components/chat/chat-container';
import { generateUUID } from '@/lib/utils';
import { DataStreamHandler } from '@/components/data-stream-handler';

export default async function Page(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { id } = params;
  const session = await getSessionById(id);

  if (!session) {
    notFound();
  }

  const cookieStore = await cookies();
  const modelIdFromCookie = cookieStore.get('model-id')?.value;

  const selectedModelId =
    models.find((model) => model.id === modelIdFromCookie)?.id ||
    DEFAULT_MODEL_NAME;

  return (
    <>
      <Chat
        key={id}
        id={id}
        initialMessages={[]}
        selectedModelId={selectedModelId}
        selectedVisibilityType="private"
        isReadonly={false}
      />
      <DataStreamHandler id={id} />
    </>
  );
}
