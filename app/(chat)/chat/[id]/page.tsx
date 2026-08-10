import { Chat } from '@/components/chat/chat-container';
import { requireAuthAccess } from '@/lib/auth/access';
import { evaluateSessionAccess } from '@/lib/chat/access';
import {
  resolveSessionGrant,
  sessionGrantCanRead,
} from '@/lib/chat/session-access';
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

  // Read gate: the session creator, or a member of its PUBLIC workspace
  // on a shared session. Manage-only grants (workspace owner/admin
  // curating members' private sessions, global admins) can list/rename/
  // delete but NEVER read message content.
  if (session) {
    const grant = await resolveSessionGrant(access, session);
    if (!grant || !sessionGrantCanRead(grant)) {
      notFound();
    }
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
              metadata: {
                agent:
                  typeof session.metadata?.agent === 'string'
                    ? (session.metadata.agent as string)
                    : null,
              },
              accessDenied: hasAccessDeniedMetadata(session.metadata),
              readOnlyChannel,
            }
          : null
      }
    />
  );
}
