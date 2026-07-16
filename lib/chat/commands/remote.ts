import type { Locale } from '@/lib/i18n';
import { t } from '@/lib/i18n/server';
import type { ChatSession } from '@/lib/core/db/schema';
import type { ChatSource } from '@/types/workflow';
import { isCliOnlineForSession } from '@/lib/cli/remote-control';
import { db } from '@/lib/core/db';
import { chatSessions } from '@/lib/core/db/schema';
import { eq, and, isNotNull } from 'drizzle-orm';

export async function executeAttachCommand(opts: {
  args: string;
  currentSession: ChatSession | null;
  source: ChatSource;
  locale: Locale;
}): Promise<{ sessionId: string | null; text: string; runId: string | null }> {
  const { args, currentSession, source, locale } = opts;

  if (!currentSession) {
    return {
      sessionId: null,
      text: t(locale, 'cmd.attach.noSession'),
      runId: null,
    };
  }

  if (source.type !== 'im') {
    return {
      sessionId: currentSession.id,
      text: t(locale, 'cmd.attach.imOnly'),
      runId: currentSession.workflowRunId,
    };
  }

  const targetSessionId = args.trim();
  if (!targetSessionId) {
    return {
      sessionId: currentSession.id,
      text: t(locale, 'cmd.attach.missingSessionId'),
      runId: currentSession.workflowRunId,
    };
  }

  // Verify target session exists and is a CLI session
  const [targetSession] = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, targetSessionId))
    .limit(1);

  if (!targetSession) {
    return {
      sessionId: currentSession.id,
      text: t(locale, 'cmd.attach.sessionNotFound', {
        sessionId: targetSessionId,
      }),
      runId: currentSession.workflowRunId,
    };
  }

  if (targetSession.channel !== 'cli') {
    return {
      sessionId: currentSession.id,
      text: t(locale, 'cmd.attach.notCliSession', {
        sessionId: targetSessionId,
      }),
      runId: currentSession.workflowRunId,
    };
  }

  // Check if CLI is online
  const online = await isCliOnlineForSession(targetSessionId);
  if (!online) {
    return {
      sessionId: currentSession.id,
      text: t(locale, 'cmd.attach.cliOffline', { sessionId: targetSessionId }),
      runId: currentSession.workflowRunId,
    };
  }

  // Attach: set remoteControlNodeId on current session
  try {
    const { setImAttachment } = await import('@/lib/cli/remote-control');
    await setImAttachment(source.adapter, source.threadId, targetSessionId);

    await db
      .update(chatSessions)
      .set({ remoteControlNodeId: targetSessionId })
      .where(eq(chatSessions.id, currentSession.id));

    return {
      sessionId: currentSession.id,
      text: t(locale, 'cmd.attach.success', { sessionId: targetSessionId }),
      runId: currentSession.workflowRunId,
    };
  } catch (error) {
    return {
      sessionId: currentSession.id,
      text: t(locale, 'cmd.attach.failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
      runId: currentSession.workflowRunId,
    };
  }
}

export async function executeDetachCommand(opts: {
  currentSession: ChatSession | null;
  source: ChatSource;
  locale: Locale;
}): Promise<{ sessionId: string | null; text: string; runId: string | null }> {
  const { currentSession, source, locale } = opts;

  if (!currentSession) {
    return {
      sessionId: null,
      text: t(locale, 'cmd.detach.noSession'),
      runId: null,
    };
  }

  if (source.type !== 'im') {
    return {
      sessionId: currentSession.id,
      text: t(locale, 'cmd.detach.imOnly'),
      runId: currentSession.workflowRunId,
    };
  }

  if (!currentSession.remoteControlNodeId) {
    return {
      sessionId: currentSession.id,
      text: t(locale, 'cmd.detach.notAttached'),
      runId: currentSession.workflowRunId,
    };
  }

  try {
    const { clearImAttachment } = await import('@/lib/cli/remote-control');
    await clearImAttachment(source.adapter, source.threadId);

    await db
      .update(chatSessions)
      .set({ remoteControlNodeId: null })
      .where(eq(chatSessions.id, currentSession.id));

    return {
      sessionId: currentSession.id,
      text: t(locale, 'cmd.detach.success'),
      runId: currentSession.workflowRunId,
    };
  } catch (error) {
    return {
      sessionId: currentSession.id,
      text: t(locale, 'cmd.detach.failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
      runId: currentSession.workflowRunId,
    };
  }
}

export async function executeRemoteCommand(opts: {
  currentSession: ChatSession | null;
  source: ChatSource;
  locale: Locale;
}): Promise<{ sessionId: string | null; text: string; runId: string | null }> {
  const { currentSession, source, locale } = opts;

  if (!currentSession) {
    return {
      sessionId: null,
      text: t(locale, 'cmd.remote.noSession'),
      runId: null,
    };
  }

  if (source.type !== 'im') {
    return {
      sessionId: currentSession.id,
      text: t(locale, 'cmd.remote.imOnly'),
      runId: currentSession.workflowRunId,
    };
  }

  try {
    // Find all CLI sessions with online status
    const cliSessions = await db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.channel, 'cli'),
          isNotNull(chatSessions.channelOrigin),
        ),
      )
      .orderBy(chatSessions.updatedAt)
      .limit(20);

    if (cliSessions.length === 0) {
      return {
        sessionId: currentSession.id,
        text: t(locale, 'cmd.remote.noCliSessions'),
        runId: currentSession.workflowRunId,
      };
    }

    // Check online status for each
    const { getCliCapabilities } = await import('@/lib/cli/remote-control');
    const entries = await Promise.all(
      cliSessions.map(async (sess, idx) => {
        const caps = await getCliCapabilities(sess.id);
        const status = caps ? 'online' : 'offline';
        const device = sess.channelOrigin || 'unknown';
        const platform = caps?.capabilities?.platform || 'unknown';
        return t(locale, 'cmd.remote.entry', {
          index: String(idx + 1),
          sessionId: sess.id,
          status,
          device,
          platform,
        });
      }),
    );

    const text = [
      t(locale, 'cmd.remote.header'),
      ...entries,
      '',
      t(locale, 'cmd.remote.attachHint'),
    ].join('\n');

    return {
      sessionId: currentSession.id,
      text,
      runId: currentSession.workflowRunId,
    };
  } catch (error) {
    return {
      sessionId: currentSession.id,
      text: t(locale, 'cmd.remote.failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
      runId: currentSession.workflowRunId,
    };
  }
}
