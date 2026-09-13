import { describe, expect, it } from 'vitest';

import { readProxyEnv, shouldEnableProxy } from './outbound-proxy';

describe('shouldEnableProxy', () => {
  it('enables when HTTPS_PROXY is set', () => {
    expect(shouldEnableProxy({ HTTPS_PROXY: 'http://proxy:8080' })).toBe(true);
  });

  it('enables when only HTTP_PROXY is set', () => {
    expect(shouldEnableProxy({ HTTP_PROXY: 'http://proxy:8080' })).toBe(true);
  });

  it('does not enable on NO_PROXY alone', () => {
    expect(shouldEnableProxy({ NO_PROXY: 'localhost,127.0.0.1' })).toBe(false);
  });

  it('does not enable when nothing is set', () => {
    expect(shouldEnableProxy({})).toBe(false);
  });

  it('ignores empty-string values at env resolution', () => {
    const env = readProxyEnv({
      HTTPS_PROXY: '',
      http_proxy: '   ',
      NO_PROXY: 'localhost',
    });
    expect(env).toEqual({ NO_PROXY: 'localhost' });
    expect(shouldEnableProxy(env)).toBe(false);
  });

  it('prefers the uppercase form and trims whitespace', () => {
    const env = readProxyEnv({
      https_proxy: 'http://lower:1',
      HTTPS_PROXY: '  http://upper:2  ',
    });
    expect(env.HTTPS_PROXY).toBe('http://upper:2');
  });
});
