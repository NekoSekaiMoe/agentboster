import { beforeEach, describe, expect, it, vi } from 'vitest';

const { webhookMocks, ofetchRawMock } = vi.hoisted(() => ({
  webhookMocks: {
    assertBotAuthSecret: vi.fn(() => 'bot-secret'),
    getAppBaseUrl: vi.fn(() => 'http://app.local'),
  },
  ofetchRawMock: vi.fn(),
}));

vi.mock('workflow', () => ({
  sleep: vi.fn(),
}));

vi.mock('@/lib/bot/webhook', () => webhookMocks);

vi.mock('ofetch', () => ({
  ofetch: { raw: ofetchRawMock },
}));

import { postHeartbeatTrigger, shouldRecordTriggerFailure } from './heartbeat';

describe('shouldRecordTriggerFailure', () => {
  it('never records a successful trigger', () => {
    expect(shouldRecordTriggerFailure({ ok: true, status: 200 })).toBe(false);
    expect(shouldRecordTriggerFailure({ ok: true, status: 204 })).toBe(false);
  });

  it('does not re-count a 500 — the endpoint already recorded it', () => {
    // deliverSessionHeartbeat's markFailed → recordHeartbeatResult ran on
    // the endpoint side before the route answered 500.
    expect(shouldRecordTriggerFailure({ ok: false, status: 500 })).toBe(false);
  });

  it('records when the request never reached the endpoint', () => {
    // Missing auth secret / bad base URL / network failure — nothing ran
    // on the other side, so nothing was counted there.
    expect(shouldRecordTriggerFailure({ ok: false, status: null })).toBe(true);
  });

  it('records endpoint 4xx responses the endpoint did not count', () => {
    expect(shouldRecordTriggerFailure({ ok: false, status: 403 })).toBe(true);
    expect(shouldRecordTriggerFailure({ ok: false, status: 400 })).toBe(true);
  });

  it('records proxy 5xx responses that never reached the app', () => {
    expect(shouldRecordTriggerFailure({ ok: false, status: 502 })).toBe(true);
    expect(shouldRecordTriggerFailure({ ok: false, status: 504 })).toBe(true);
  });
});

describe('postHeartbeatTrigger', () => {
  beforeEach(() => {
    ofetchRawMock.mockReset();
    webhookMocks.assertBotAuthSecret.mockClear();
    webhookMocks.getAppBaseUrl.mockClear();
  });

  it('resolves with ok/status for a 2xx response', async () => {
    ofetchRawMock.mockResolvedValue({ ok: true, status: 200 });

    await expect(postHeartbeatTrigger('sess-1')).resolves.toEqual({
      ok: true,
      status: 200,
    });
    expect(ofetchRawMock).toHaveBeenCalledWith(
      'http://app.local/api/bot/bot-secret/heartbeat',
      expect.objectContaining({
        method: 'POST',
        body: { sessionId: 'sess-1' },
      }),
    );
  });

  it('resolves (does not throw) with the failing status', async () => {
    // ignoreResponseError: true — the status must survive to the caller so
    // the counting decision can see who already recorded the failure.
    ofetchRawMock.mockResolvedValue({ ok: false, status: 500 });

    await expect(postHeartbeatTrigger('sess-1')).resolves.toEqual({
      ok: false,
      status: 500,
    });
    expect(ofetchRawMock).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ ignoreResponseError: true }),
    );
  });

  it('propagates pre-request failures (no response exists)', async () => {
    // assertBotAuthSecret throws before any HTTP request is made — the
    // wake loop classifies this as status: null (never reached endpoint).
    webhookMocks.assertBotAuthSecret.mockImplementation(() => {
      throw new Error('AUTH_SECRET is not configured');
    });

    await expect(postHeartbeatTrigger('sess-1')).rejects.toThrow(
      'AUTH_SECRET is not configured',
    );
  });
});
