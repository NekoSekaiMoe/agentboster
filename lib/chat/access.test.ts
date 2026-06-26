import { describe, it, expect } from 'vitest';
import {
  CrossChannelReadonlyError,
  assertSessionWritable,
  currentChannelName,
  evaluateSessionAccess,
  isReadOnlyAccess,
} from '@/lib/chat/access';
import type { ChatSource } from '@/types/workflow';

const webSource = (userId = 'user-1'): ChatSource => ({
  type: 'web',
  userId,
});

const imSource = (
  adapter: 'telegram' | 'discord' = 'telegram',
  userId = 'user-1',
): ChatSource => ({
  type: 'im',
  adapter,
  origin: 'https://example.com',
  threadId: 'thread-1',
  userId,
});

const cliSource = (clientId = 'laptop-1', userId = 'user-1'): ChatSource => ({
  type: 'cli',
  clientId,
  userId,
});

const session = (overrides: { userId?: string | null; channel: string }) => ({
  userId: overrides.userId === undefined ? 'user-1' : overrides.userId,
  channel: overrides.channel,
});

describe('currentChannelName', () => {
  it('returns "web" for web source', () => {
    expect(currentChannelName(webSource())).toBe('web');
  });

  it('returns adapter name for im source', () => {
    expect(currentChannelName(imSource('discord'))).toBe('discord');
  });

  it('returns "scheduled" for scheduled source', () => {
    expect(currentChannelName({ type: 'scheduled' })).toBe('scheduled');
  });

  it('returns "cli:<clientId>" for cli source', () => {
    expect(currentChannelName(cliSource('my-laptop'))).toBe('cli:my-laptop');
  });
});

describe('evaluateSessionAccess', () => {
  describe('web source', () => {
    it('grants write access when channel is web and userId matches', () => {
      const result = evaluateSessionAccess(
        webSource(),
        session({ channel: 'web' }),
      );
      expect(result).toEqual({ accessible: true, readOnly: false });
    });

    it('grants read-only access when channel is an IM adapter', () => {
      const result = evaluateSessionAccess(
        webSource(),
        session({ channel: 'telegram' }),
      );
      expect(result.accessible).toBe(true);
      expect(isReadOnlyAccess(result)).toBe(true);
      if (result.accessible && result.readOnly) {
        expect(result.reason).toBe('cross-channel');
        expect(result.sessionChannel).toBe('telegram');
        expect(result.currentChannel).toBe('web');
      }
    });

    it('grants read-only access when channel is cli:*', () => {
      const result = evaluateSessionAccess(
        webSource(),
        session({ channel: 'cli:my-laptop' }),
      );
      expect(result.accessible).toBe(true);
      expect(isReadOnlyAccess(result)).toBe(true);
      if (result.accessible && result.readOnly) {
        expect(result.reason).toBe('cross-channel');
        expect(result.sessionChannel).toBe('cli:my-laptop');
      }
    });

    it('denies access when userId does not match', () => {
      const result = evaluateSessionAccess(
        webSource('user-1'),
        session({ userId: 'user-2', channel: 'web' }),
      );
      expect(result.accessible).toBe(false);
      if (!result.accessible) {
        expect(result.reason).toBe('forbidden');
      }
    });

    it('denies access when web source has no userId', () => {
      const result = evaluateSessionAccess(
        { type: 'web' } as ChatSource,
        session({ channel: 'web' }),
      );
      expect(result.accessible).toBe(false);
    });

    it('denies access when session userId is null (no implicit ownership)', () => {
      const result = evaluateSessionAccess(
        webSource('user-1'),
        session({ userId: null, channel: 'web' }),
      );
      expect(result.accessible).toBe(false);
    });
  });

  describe('im source', () => {
    it('grants write access when adapter matches channel', () => {
      const result = evaluateSessionAccess(
        imSource('telegram'),
        session({ channel: 'telegram' }),
      );
      expect(result).toEqual({ accessible: true, readOnly: false });
    });

    it('denies access when adapter does not match channel', () => {
      const result = evaluateSessionAccess(
        imSource('telegram'),
        session({ channel: 'discord' }),
      );
      expect(result.accessible).toBe(false);
      if (!result.accessible) {
        expect(result.reason).toBe('cross-channel-strict');
        expect(result.sessionChannel).toBe('discord');
        expect(result.currentChannel).toBe('telegram');
      }
    });

    it('denies access when session channel is web', () => {
      const result = evaluateSessionAccess(
        imSource('telegram'),
        session({ channel: 'web' }),
      );
      expect(result.accessible).toBe(false);
      if (!result.accessible) {
        expect(result.reason).toBe('cross-channel-strict');
      }
    });

    it('denies access when userId does not match', () => {
      const result = evaluateSessionAccess(
        imSource('telegram', 'user-1'),
        session({ userId: 'user-2', channel: 'telegram' }),
      );
      expect(result.accessible).toBe(false);
      if (!result.accessible) {
        expect(result.reason).toBe('forbidden');
      }
    });
  });

  describe('scheduled source', () => {
    it('grants write access (fallback for system-initiated runs)', () => {
      const result = evaluateSessionAccess(
        { type: 'scheduled' },
        session({ channel: 'web' }),
      );
      expect(result).toEqual({ accessible: true, readOnly: false });
    });
  });

  describe('cli source', () => {
    it('grants write access when channel matches cli:<clientId>', () => {
      const result = evaluateSessionAccess(
        cliSource('laptop-1'),
        session({ channel: 'cli:laptop-1' }),
      );
      expect(result).toEqual({ accessible: true, readOnly: false });
    });

    it('denies access when channel is a different cli client (cross-machine)', () => {
      const result = evaluateSessionAccess(
        cliSource('laptop-1'),
        session({ channel: 'cli:laptop-2' }),
      );
      expect(result.accessible).toBe(false);
      if (!result.accessible) {
        expect(result.reason).toBe('cross-channel-strict');
        expect(result.sessionChannel).toBe('cli:laptop-2');
        expect(result.currentChannel).toBe('cli:laptop-1');
      }
    });

    it('denies access when session channel is web', () => {
      const result = evaluateSessionAccess(
        cliSource('laptop-1'),
        session({ channel: 'web' }),
      );
      expect(result.accessible).toBe(false);
      if (!result.accessible) {
        expect(result.reason).toBe('cross-channel-strict');
      }
    });

    it('denies access when session channel is an IM adapter', () => {
      const result = evaluateSessionAccess(
        cliSource('laptop-1'),
        session({ channel: 'telegram' }),
      );
      expect(result.accessible).toBe(false);
      if (!result.accessible) {
        expect(result.reason).toBe('cross-channel-strict');
      }
    });

    it('denies access when userId does not match', () => {
      const result = evaluateSessionAccess(
        cliSource('laptop-1', 'user-1'),
        session({ userId: 'user-2', channel: 'cli:laptop-1' }),
      );
      expect(result.accessible).toBe(false);
      if (!result.accessible) {
        expect(result.reason).toBe('forbidden');
      }
    });

    it('denies access when cli source has no userId', () => {
      const result = evaluateSessionAccess(
        { type: 'cli', clientId: 'laptop-1' },
        session({ channel: 'cli:laptop-1' }),
      );
      expect(result.accessible).toBe(false);
    });
  });
});

describe('assertSessionWritable', () => {
  const writableSession = { id: 's1', userId: 'user-1', channel: 'web' };

  it('does not throw for writable web session', () => {
    expect(() =>
      assertSessionWritable(webSource(), writableSession),
    ).not.toThrow();
  });

  it('throws CrossChannelReadonlyError when web accesses IM channel', () => {
    expect(() =>
      assertSessionWritable(webSource(), {
        id: 's1',
        userId: 'user-1',
        channel: 'telegram',
      }),
    ).toThrow(CrossChannelReadonlyError);
  });

  it('throws plain Error when userId does not match', () => {
    expect(() =>
      assertSessionWritable(webSource('user-1'), {
        id: 's1',
        userId: 'user-2',
        channel: 'web',
      }),
    ).toThrow('Forbidden');
  });

  it('throws plain Error when im accesses different adapter', () => {
    expect(() =>
      assertSessionWritable(imSource('telegram'), {
        id: 's1',
        userId: 'user-1',
        channel: 'discord',
      }),
    ).toThrow();
  });

  it('CrossChannelReadonlyError carries channel metadata', () => {
    try {
      assertSessionWritable(webSource(), {
        id: 's1',
        userId: 'user-1',
        channel: 'telegram',
      });
      expect.fail('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CrossChannelReadonlyError);
      if (error instanceof CrossChannelReadonlyError) {
        expect(error.sessionId).toBe('s1');
        expect(error.sessionChannel).toBe('telegram');
        expect(error.currentChannel).toBe('web');
        expect(error.message).toContain('telegram');
        expect(error.message).toContain('web');
      }
    }
  });

  it('does not throw when cli source matches its own channel', () => {
    expect(() =>
      assertSessionWritable(cliSource('laptop-1'), {
        id: 's1',
        userId: 'user-1',
        channel: 'cli:laptop-1',
      }),
    ).not.toThrow();
  });

  it('throws plain Error when cli source accesses a different cli client', () => {
    expect(() =>
      assertSessionWritable(cliSource('laptop-1'), {
        id: 's1',
        userId: 'user-1',
        channel: 'cli:laptop-2',
      }),
    ).toThrow();
  });
});

describe('CrossChannelReadonlyError contract (api route 403 body shape)', () => {
  it('serializes to the JSON shape the web client parses', () => {
    // Mirrors what app/(chat)/api/ai/route.ts returns when catching this error.
    let caught: CrossChannelReadonlyError | null = null;
    try {
      assertSessionWritable(webSource(), {
        id: 's-abc',
        userId: 'user-1',
        channel: 'telegram',
      });
    } catch (error) {
      if (error instanceof CrossChannelReadonlyError) {
        caught = error;
      }
    }
    expect(caught).not.toBeNull();
    if (!caught) return;

    // The 403 response body the route handler builds:
    const responseBody = {
      success: false,
      error: 'cross_channel_readonly',
      message: caught.message,
      sessionChannel: caught.sessionChannel,
      currentChannel: caught.currentChannel,
    };

    // The fields chat-container.tsx's transport.fetch reads:
    expect(responseBody.error).toBe('cross_channel_readonly');
    expect(typeof responseBody.sessionChannel).toBe('string');
    expect(responseBody.sessionChannel).toBe('telegram');
    expect(responseBody.currentChannel).toBe('web');
    expect(responseBody.message).toContain('telegram');
    expect(responseBody.message).toContain('web');
  });
});
