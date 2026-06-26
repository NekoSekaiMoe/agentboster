import type { ChatSource } from '@/types/workflow';

export type SessionChannelInfo = {
  userId: string | null;
  channel: string;
};

export type SessionAccessResult =
  | { accessible: true; readOnly: false }
  | {
      accessible: true;
      readOnly: true;
      reason: 'cross-channel';
      sessionChannel: string;
      currentChannel: string;
    }
  | {
      accessible: false;
      readOnly: false;
      reason: 'forbidden' | 'cross-channel-strict';
      sessionChannel?: string;
      currentChannel?: string;
    };

const CLI_CHANNEL_PREFIX = 'cli:';

export function currentChannelName(source: ChatSource): string {
  if (source.type === 'web') return 'web';
  if (source.type === 'im') return source.adapter;
  return 'scheduled';
}

function isImChannel(channel: string): boolean {
  return (
    channel !== 'web' &&
    !channel.startsWith(CLI_CHANNEL_PREFIX) &&
    channel !== 'scheduled'
  );
}

export function evaluateSessionAccess(
  source: ChatSource,
  session: SessionChannelInfo,
): SessionAccessResult {
  const currentChannel = currentChannelName(source);

  if (source.type === 'web') {
    if (!source.userId || session.userId !== source.userId) {
      return { accessible: false, readOnly: false, reason: 'forbidden' };
    }

    if (session.channel === 'web') {
      return { accessible: true, readOnly: false };
    }

    return {
      accessible: true,
      readOnly: true,
      reason: 'cross-channel',
      sessionChannel: session.channel,
      currentChannel,
    };
  }

  if (source.type === 'im') {
    if (!source.userId || session.userId !== source.userId) {
      return { accessible: false, readOnly: false, reason: 'forbidden' };
    }

    if (session.channel === source.adapter) {
      return { accessible: true, readOnly: false };
    }

    return {
      accessible: false,
      readOnly: false,
      reason: 'cross-channel-strict',
      sessionChannel: session.channel,
      currentChannel,
    };
  }

  return { accessible: true, readOnly: false };
}

export function isReadOnlyAccess(
  result: SessionAccessResult,
): result is Extract<SessionAccessResult, { readOnly: true }> {
  return result.accessible && result.readOnly;
}

export { CLI_CHANNEL_PREFIX, isImChannel };

export class CrossChannelReadonlyError extends Error {
  readonly sessionChannel: string;
  readonly currentChannel: string;
  readonly sessionId: string;

  constructor(input: {
    sessionId: string;
    sessionChannel: string;
    currentChannel: string;
  }) {
    super(
      `此会话渠道与当前渠道不同(会话渠道 ${input.sessionChannel},当前渠道 ${input.currentChannel})`,
    );
    this.name = 'CrossChannelReadonlyError';
    this.sessionChannel = input.sessionChannel;
    this.currentChannel = input.currentChannel;
    this.sessionId = input.sessionId;
  }
}

export function assertSessionWritable(
  source: ChatSource,
  session: SessionChannelInfo & { id: string },
): void {
  const access = evaluateSessionAccess(source, session);
  if (!access.accessible) {
    throw new Error(
      access.reason === 'cross-channel-strict'
        ? `此会话渠道与当前渠道不同(会话渠道 ${access.sessionChannel ?? session.channel},当前渠道 ${access.currentChannel ?? currentChannelName(source)})`
        : 'Forbidden',
    );
  }
  if (access.readOnly) {
    throw new CrossChannelReadonlyError({
      sessionId: session.id,
      sessionChannel: access.sessionChannel,
      currentChannel: access.currentChannel,
    });
  }
}
