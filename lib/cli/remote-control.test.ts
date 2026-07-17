import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/core/kv', () => ({
  get: vi.fn(),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  expire: vi.fn().mockResolvedValue(1),
}));

import {
  registerCliListener,
  unregisterCliListener,
  getCliListener,
  pushToCliSession,
  markCliOnline,
  getCliCapabilities,
  markCliOffline,
  setImAttachment,
  getAttachedSessionId,
  clearImAttachment,
  handleCliSessionSwitch,
} from '@/lib/cli/remote-control';
import { get, set, del } from '@/lib/core/kv';

describe('CLI Remote Control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    unregisterCliListener('test-session');
  });

  describe('Listener registry', () => {
    it('registers and retrieves a listener', () => {
      const listener = {
        send: vi.fn(),
        sessionId: 'test-session',
        connectedAt: Date.now(),
      };
      registerCliListener('test-session', listener);
      expect(getCliListener('test-session')).toBe(listener);
    });

    it('returns null for unregistered session', () => {
      expect(getCliListener('nonexistent')).toBeNull();
    });

    it('replaces existing listener on re-register', () => {
      const l1 = {
        send: vi.fn(),
        sessionId: 'test-session',
        connectedAt: 1,
      };
      const l2 = {
        send: vi.fn(),
        sessionId: 'test-session',
        connectedAt: 2,
      };
      registerCliListener('test-session', l1);
      registerCliListener('test-session', l2);
      expect(getCliListener('test-session')).toBe(l2);
    });

    it('unregisters a listener', () => {
      const listener = {
        send: vi.fn(),
        sessionId: 'test-session',
        connectedAt: Date.now(),
      };
      registerCliListener('test-session', listener);
      unregisterCliListener('test-session');
      expect(getCliListener('test-session')).toBeNull();
    });
  });

  describe('pushToCliSession', () => {
    it('delivers via in-process listener when registered', async () => {
      const sendFn = vi.fn();
      registerCliListener('test-session', {
        send: sendFn,
        sessionId: 'test-session',
        connectedAt: Date.now(),
      });

      const delivered = await pushToCliSession('test-session', 'test-event', {
        foo: 1,
      });
      expect(delivered).toBe(true);
      expect(sendFn).toHaveBeenCalledWith('test-event', { foo: 1 });
    });

    it('falls back to KV when no listener', async () => {
      const delivered = await pushToCliSession('no-listener', 'test-event', {});
      expect(delivered).toBe(false);
    });
  });

  describe('KV online state', () => {
    it('stores and retrieves CLI capabilities', async () => {
      await markCliOnline('sess-1', {
        capabilities: {
          hasDisplay: true,
          platform: 'darwin',
          isAdmin: false,
          scaleFactor: 2,
        },
        cwd: '/home/user',
      });

      expect(set).toHaveBeenCalledWith(
        'cli-remote:sess-1',
        expect.any(String),
        { ex: 120 },
      );

      const stored = vi.mocked(set).mock.calls[0]?.[1];
      vi.mocked(get).mockResolvedValueOnce(stored as string);

      const caps = await getCliCapabilities('sess-1');
      expect(caps?.capabilities.hasDisplay).toBe(true);
      expect(caps?.capabilities.platform).toBe('darwin');
      expect(caps?.cwd).toBe('/home/user');
    });

    it('returns null when offline', async () => {
      vi.mocked(get).mockResolvedValueOnce(null);
      const caps = await getCliCapabilities('sess-2');
      expect(caps).toBeNull();
    });

    it('deletes KV key on markCliOffline', async () => {
      await markCliOffline('sess-1');
      expect(del).toHaveBeenCalledWith('cli-remote:sess-1');
    });
  });

  describe('IM attachment bindings', () => {
    it('sets and retrieves attachment', async () => {
      await setImAttachment('telegram', 'thread-1', 'sess-1');
      expect(set).toHaveBeenCalledWith('im-attach:telegram:thread-1', 'sess-1');

      vi.mocked(get).mockResolvedValueOnce('sess-1');
      const sessionId = await getAttachedSessionId('telegram', 'thread-1');
      expect(sessionId).toBe('sess-1');
    });

    it('clears attachment', async () => {
      vi.mocked(get).mockResolvedValueOnce('sess-1');
      await clearImAttachment('telegram', 'thread-1');
      expect(del).toHaveBeenCalledWith('im-attach:telegram:thread-1');
      expect(del).toHaveBeenCalledWith('cli-im-binding:sess-1');
    });
  });

  describe('Session switch', () => {
    it('migrates IM binding from old to new session', async () => {
      vi.mocked(get).mockResolvedValueOnce(
        JSON.stringify({ adapter: 'telegram', threadId: 'thread-1' }),
      );

      const binding = await handleCliSessionSwitch('old-sess', 'new-sess');
      expect(binding).toEqual({ adapter: 'telegram', threadId: 'thread-1' });
      expect(del).toHaveBeenCalledWith('im-attach:telegram:thread-1');
      expect(del).toHaveBeenCalledWith('cli-im-binding:old-sess');
      expect(set).toHaveBeenCalledWith(
        'im-attach:telegram:thread-1',
        'new-sess',
      );
    });

    it('returns null when no binding exists', async () => {
      vi.mocked(get).mockResolvedValueOnce(null);
      const binding = await handleCliSessionSwitch('old-sess', 'new-sess');
      expect(binding).toBeNull();
    });
  });
});
