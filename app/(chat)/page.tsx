import { Chat } from '@/components/chat/chat-container';
import { getAppBaseUrl } from '@/lib/bot/webhook';
import { generateUUID } from '@/lib/utils';
import type { Metadata } from 'next';

const APP_NAME = 'AgentBoster';
const CHAT_DESCRIPTION = 'Start a new conversation with AgentBoster.';
const APP_BASE_URL = getAppBaseUrl();
const APP_ICON_URL = `${APP_BASE_URL}/icon.png`;

export const metadata: Metadata = {
  title: 'New Chat',
  description: CHAT_DESCRIPTION,
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: '/',
    siteName: APP_NAME,
    title: `New Chat | ${APP_NAME}`,
    description: CHAT_DESCRIPTION,
    images: [
      {
        url: APP_ICON_URL,
        width: 512,
        height: 512,
        alt: 'AgentBoster logo',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: `New Chat | ${APP_NAME}`,
    description: CHAT_DESCRIPTION,
    images: [APP_ICON_URL],
  },
};

/**
 * New conversation entry page.
 *
 * **Lazy session creation flow:**
 * 1. During SSR, generate a random UUID as chatId (sessionId).
 * 2. No DB session row exists yet; this is only a placeholder ID.
 * 3. When the user sends the first message, the frontend posts it with this chatId to POST /api/ai.
 * 4. Before persisting the first message, chat layer checks the DB and creates a new session row with this UUID if missing.
 *
 * Benefit: avoids piling up empty sessions, while allowing early navigation to /chat/{id}.
 */
export default async function Page() {
  const id = generateUUID();

  return (
    <>
      <Chat key={id} id={id} />
    </>
  );
}
