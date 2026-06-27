import { Chat } from '@/components/chat/chat-container';
import { canAccessOwnedResource, requireAuthAccess } from '@/lib/auth/access';
import { evaluateSessionAccess } from '@/lib/chat/access';
import { deserializePersistedMessages } from '@/lib/chat/persistence';
import { getSession, getVisibleSessionMessages } from '@/lib/core/db/chat';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

function hasAccessDeniedMetadata(metadata: unknown): boolean {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    Boolean((metadata as { accessDenied?: unknown }).accessDenied)
  );
}

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cookieStore = await cookies();
  const access = await requireAuthAccess(cookieStore);
  const session = await getSession(id);

  if (session && !canAccessOwnedResource(access, session.userId)) {
    notFound();
  }

  const visibleMessages = session ? await getVisibleSessionMessages(id) : [];
  const initialMessages = deserializePersistedMessages(visibleMessages);

  let readOnlyChannel: { sessionChannel: string } | null = null;
  if (session) {
    const result = evaluateSessionAccess(
      { type: 'web', userId: access.session.userId },
      { userId: session.userId, channel: session.channel },
    );
    if (
      result.accessible &&
      result.readOnly &&
      result.reason === 'cross-channel'
    ) {
      readOnlyChannel = { sessionChannel: result.sessionChannel };
    }
  }

  return (
    <Chat
      key={id}
      id={id}
      initialMessages={initialMessages}
      session={
        session
          ? {
              id: session.id,
              title: session.title,
              channel: session.channel,
              externalThreadId: session.externalThreadId ?? null,
              model: session.model ?? null,
              accessDenied: hasAccessDeniedMetadata(session.metadata),
              readOnlyChannel,
            }
          : null
      }
    />
  );
}
