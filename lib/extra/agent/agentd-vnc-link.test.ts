import { describe, expect, it } from 'vitest';

import { buildAgentdDesktopWsUrl, signAgentdVncLink } from './agentd-vnc-link';

describe('agentd-vnc-link', () => {
  it('signs a stable session-scoped signature', () => {
    const signed = signAgentdVncLink({
      sessionId: 'sess_123',
      secret: 'secret-key',
      nowMs: 1_700_000_000_000,
      ttlSeconds: 300,
    });

    expect(signed).toEqual({
      expires: 1_700_000_300,
      signature:
        '76e863d9792f6497e4197a8ac9bb9bee77e14184000292559db244be2e851d0c',
    });
  });

  it('builds a websocket proxy URL with signed query params', () => {
    const url = buildAgentdDesktopWsUrl({
      baseUrl: 'https://agentd.example.com/root',
      sessionId: 'sess_123',
      secret: 'secret-key',
      nowMs: 1_700_000_000_000,
      ttlSeconds: 300,
    });

    expect(url).toBe(
      'wss://agentd.example.com/api/v1/desktop/vnc?session_id=sess_123&exp=1700000300&sig=76e863d9792f6497e4197a8ac9bb9bee77e14184000292559db244be2e851d0c',
    );
  });
});
