import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/core/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

vi.mock('@/lib/core/db/schema', () => ({
  sessions: {
    id: 'id',
    channel: 'channel',
    userId: 'userId',
    channelOrigin: 'channelOrigin',
    updatedAt: 'updatedAt',
    remoteControlNodeId: 'remoteControlNodeId',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col, val) => ({ op: 'eq', val })),
  and: vi.fn((...args) => ({ op: 'and', args })),
  isNotNull: vi.fn((col) => ({ op: 'isNotNull', col })),
}));

vi.mock('@/lib/cli/remote-control', () => ({
  isCliOnlineForSession: vi.fn(),
  setImAttachment: vi.fn().mockResolvedValue(undefined),
  clearImAttachment: vi.fn().mockResolvedValue(undefined),
  getCliCapabilities: vi.fn(),
}));

vi.mock('@/lib/i18n/server', () => ({
  t: vi.fn((_locale, key, _params) => key),
}));

import {
  executeAttachCommand,
  executeDetachCommand,
  executeRemoteCommand,
} from '@/lib/chat/commands/remote';
import { isCliOnlineForSession } from '@/lib/cli/remote-control';
import type { IMChatSource, CLIChatSource } from '@/types/workflow';

const imSource: IMChatSource = {
  type: 'im',
  adapter: 'telegram',
  origin: 'chat-123',
  threadId: 'thread-1',
};

const cliSource: CLIChatSource = {
  type: 'cli',
  clientId: 'client-1',
};

const mockSession = {
  id: 'current-sess',
  userId: 'user-1',
  workflowRunId: 'run-1',
  remoteControlNodeId: null,
};

describe('executeAttachCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects non-IM sources', async () => {
    const result = await executeAttachCommand({
      args: 'target-session',
      currentSession: mockSession as any,
      source: cliSource,
      locale: 'en-US',
    });
    expect(result.text).toBe('cmd.attach.imOnly');
  });

  it('requires a target session ID', async () => {
    const result = await executeAttachCommand({
      args: '',
      currentSession: mockSession as any,
      source: imSource,
      locale: 'en-US',
    });
    expect(result.text).toBe('cmd.attach.missingSessionId');
  });

  it('returns error when no current session', async () => {
    const result = await executeAttachCommand({
      args: 'target-session',
      currentSession: null,
      source: imSource,
      locale: 'en-US',
    });
    expect(result.text).toBe('cmd.attach.noSession');
  });
});

describe('executeDetachCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects non-IM sources', async () => {
    const result = await executeDetachCommand({
      currentSession: mockSession as any,
      source: cliSource,
      locale: 'en-US',
    });
    expect(result.text).toBe('cmd.detach.imOnly');
  });

  it('returns error when not attached', async () => {
    const result = await executeDetachCommand({
      currentSession: { ...mockSession, remoteControlNodeId: null } as any,
      source: imSource,
      locale: 'en-US',
    });
    expect(result.text).toBe('cmd.detach.notAttached');
  });
});

describe('executeRemoteCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects non-IM sources', async () => {
    const result = await executeRemoteCommand({
      currentSession: mockSession as any,
      source: cliSource,
      locale: 'en-US',
    });
    expect(result.text).toBe('cmd.remote.imOnly');
  });

  it('returns error when no current session', async () => {
    const result = await executeRemoteCommand({
      currentSession: null,
      source: imSource,
      locale: 'en-US',
    });
    expect(result.text).toBe('cmd.remote.noSession');
  });
});
