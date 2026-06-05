import { Chat } from '@/components/chat/chat-container';
import { deserializePersistedMessages } from '@/lib/chat/persistence';
import { getSession, getVisibleSessionMessages } from '@/lib/core/db/chat';

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [session, visibleMessages] = await Promise.all([
    getSession(id),
    getVisibleSessionMessages(id),
  ]);
  const initialMessages = deserializePersistedMessages(visibleMessages);

  return (
    <>
      <Chat
        key={id}
        id={id}
        initialMessages={initialMessages}
        session={
          session
            ? {
                title: session.title,
                channel: session.channel,
                externalThreadId: session.externalThreadId ?? null,
              }
            : null
        }
      />
    </>
  );
}
