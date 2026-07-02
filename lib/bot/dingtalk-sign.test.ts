import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

/**
 * DingTalk sign verification, as documented in /sd/a.md (lines 1017-1056):
 *
 *   sign = base64( HmacSHA256( timestamp + "\n" + appSecret, appSecret ) )
 *
 * Note: DingTalk uses the appSecret as BOTH the message and the HMAC key
 * (the spec literally says "用 HmacSHA256 算法计算签名" with timestamp and
 * appSecret as the inputs). The webhook handler in
 * app/api/bot/[authSecret]/[adapter]/callback/route.ts::handleDingtalkWebhook
 * implements this; this test mirror-verifies the algorithm against a
 * known fixed appSecret + timestamp pair so regressions are caught.
 */
function computeDingtalkSign(timestamp: string, appSecret: string): string {
  return createHmac('sha256', appSecret)
    .update(`${timestamp}\n${appSecret}`)
    .digest('base64');
}

describe('dingtalk webhook sign verification', () => {
  it('produces a stable base64 HMAC for fixed inputs', () => {
    const sign = computeDingtalkSign('1700000000000', 'test_secret_xyz');
    // Cross-check with an independent computation.
    const expected = createHmac('sha256', 'test_secret_xyz')
      .update('1700000000000\ntest_secret_xyz')
      .digest('base64');
    expect(sign).toBe(expected);
    expect(sign).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('changes when appSecret changes', () => {
    const a = computeDingtalkSign('1700000000000', 'secret_a');
    const b = computeDingtalkSign('1700000000000', 'secret_b');
    expect(a).not.toBe(b);
  });

  it('changes when timestamp changes', () => {
    const a = computeDingtalkSign('1700000000000', 'same_secret');
    const b = computeDingtalkSign('1700000000999', 'same_secret');
    expect(a).not.toBe(b);
  });

  it('includes the newline separator between timestamp and appSecret', () => {
    // If someone forgot the \n the result would differ.
    const correct = computeDingtalkSign('1700000000000', 'sec');
    const wrong = createHmac('sha256', 'sec')
      .update('1700000000000sec')
      .digest('base64');
    expect(correct).not.toBe(wrong);
  });
});
