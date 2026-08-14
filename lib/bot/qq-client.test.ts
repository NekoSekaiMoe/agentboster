import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('fetch', vi.fn());

import {
  _clearTokenCacheForTest,
  deleteChannelMessage,
  patchChannelMessage,
  postChannelMessage,
} from './qq-client';

describe('qq-client', () => {
  const cfg = { appId: 'test-app-id', appSecret: 'test-app-secret' };

  beforeEach(() => {
    _clearTokenCacheForTest();
    vi.mocked(fetch).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getAccessToken / authentication', () => {
    it('fetches and caches access token on valid response', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'mock_token_123',
            expires_in: 7200,
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'msg_001' }),
        } as Response);

      const res = await postChannelMessage(cfg, 'chan_1', 'hello');
      expect(res.id).toBe('msg_001');
      expect(fetch).toHaveBeenCalledTimes(2);

      // Subsequent call should reuse cached token
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'msg_002' }),
      } as Response);

      const res2 = await postChannelMessage(cfg, 'chan_1', 'hello again');
      expect(res2.id).toBe('msg_002');
      expect(fetch).toHaveBeenCalledTimes(3); // 2 previous + 1 message send (no extra token fetch)
    });

    it('handles numeric string expires_in coercion', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'mock_token_coerce',
            expires_in: '3600',
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'msg_coerce' }),
        } as Response);

      const res = await postChannelMessage(cfg, 'chan_1', 'coerced token');
      expect(res.id).toBe('msg_coerce');
    });

    it('throws error when access_token is missing in 200 response', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 10001,
          message: 'invalid secret',
        }),
      } as Response);

      await expect(postChannelMessage(cfg, 'chan_1', 'hello')).rejects.toThrow(
        'qq oauth error: invalid access_token or expires_in in response',
      );
    });

    it('throws error when expires_in is missing or invalid in 200 response', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token_without_expiry',
        }),
      } as Response);

      await expect(postChannelMessage(cfg, 'chan_1', 'hello')).rejects.toThrow(
        'qq oauth error: invalid access_token or expires_in in response',
      );
    });

    it('throws error on non-ok HTTP status during token exchange', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      } as Response);

      await expect(postChannelMessage(cfg, 'chan_1', 'hello')).rejects.toThrow(
        'qq oauth error: 401 Unauthorized',
      );
    });
  });

  describe('postChannelMessage', () => {
    it('sends POST to /channels/{threadId}/messages with auth header and parses response', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'valid_token',
            expires_in: 7200,
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'msg_999' }),
        } as Response);

      const result = await postChannelMessage(cfg, 'chan_42', 'test content');
      expect(result).toEqual({ id: 'msg_999' });

      expect(fetch).toHaveBeenNthCalledWith(
        2,
        'https://api.sgroup.qq.com/channels/chan_42/messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'content-type': 'application/json',
            authorization: 'QQBot valid_token',
          }),
          body: JSON.stringify({ content: 'test content' }),
        }),
      );
    });

    it('falls back safely if message response returns empty object', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'valid_token',
            expires_in: 7200,
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({}),
        } as Response);

      const result = await postChannelMessage(cfg, 'chan_42', 'test content');
      expect(result).toEqual({});
    });

    it('falls back safely if message response json parsing fails', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'valid_token',
            expires_in: 7200,
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => {
            throw new Error('invalid json');
          },
        } as unknown as Response);

      const result = await postChannelMessage(cfg, 'chan_42', 'test content');
      expect(result).toEqual({});
    });
  });

  describe('patchChannelMessage', () => {
    it('falls back to provided messageId if response omits id', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'valid_token',
            expires_in: 7200,
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({}),
        } as Response);

      const result = await patchChannelMessage(
        cfg,
        'chan_42',
        'msg_original_id',
        'patched content',
      );
      expect(result.id).toBe('msg_original_id');
    });
  });

  describe('deleteChannelMessage', () => {
    it('sends DELETE request with auth header', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'valid_token',
            expires_in: 7200,
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => '',
        } as Response);

      await deleteChannelMessage(cfg, 'chan_42', 'msg_to_delete');
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        'https://api.sgroup.qq.com/channels/chan_42/messages/msg_to_delete',
        expect.objectContaining({
          method: 'DELETE',
          headers: { authorization: 'QQBot valid_token' },
        }),
      );
    });
  });
});
