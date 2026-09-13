import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readProxyEnv,
  redactProxyUrl,
  setupOutboundProxy,
  shouldEnableProxy,
} from './outbound-proxy';

// Install-level doubles: capture the options handed to EnvHttpProxyAgent and
// the dispatcher passed to setGlobalDispatcher, without touching the real
// undici global state.
const undiciMocks = vi.hoisted(() => {
  const agentOpts: Array<Record<string, string>> = [];
  const dispatcherArgs: unknown[] = [];
  class FakeEnvHttpProxyAgent {
    constructor(opts: Record<string, string>) {
      agentOpts.push(opts);
    }
  }
  return {
    agentOpts,
    dispatcherArgs,
    FakeEnvHttpProxyAgent,
    setGlobalDispatcher: (dispatcher: unknown) => {
      dispatcherArgs.push(dispatcher);
    },
  };
});

vi.mock('undici', () => ({
  EnvHttpProxyAgent: undiciMocks.FakeEnvHttpProxyAgent,
  setGlobalDispatcher: undiciMocks.setGlobalDispatcher,
}));

vi.mock('./index', () => ({ isSelfHosted: true }));

const ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

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

describe('redactProxyUrl', () => {
  it('strips credentials but keeps scheme, host and port', () => {
    expect(redactProxyUrl('http://user:pass@proxy.internal:8080')).toBe(
      'http://proxy.internal:8080',
    );
  });

  it('keeps credential-free URLs intact', () => {
    expect(redactProxyUrl('http://proxy.internal:8080')).toBe(
      'http://proxy.internal:8080',
    );
  });

  it('masks values that do not parse as URLs', () => {
    expect(redactProxyUrl('not a url')).toBe('<redacted>');
  });

  it('passes undefined through', () => {
    expect(redactProxyUrl(undefined)).toBeUndefined();
  });
});

describe('setupOutboundProxy', () => {
  let savedEnv: Record<string, string | undefined>;
  let info: ReturnType<typeof spyConsoleInfo>;

  function spyConsoleInfo() {
    return vi.spyOn(console, 'info').mockImplementation(() => {});
  }

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    undiciMocks.agentOpts.length = 0;
    undiciMocks.dispatcherArgs.length = 0;
    info = spyConsoleInfo();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    info.mockRestore();
  });

  it('passes the uppercase-resolved value when both cases are set', async () => {
    // undici's own env reading is lowercase-first; the agent must receive the
    // uppercase-first resolution so traffic and logging agree.
    process.env.HTTPS_PROXY = 'http://upper:1';
    process.env.https_proxy = 'http://lower:1';

    await setupOutboundProxy();

    expect(undiciMocks.agentOpts).toEqual([
      { httpsProxy: 'http://upper:1', httpProxy: '', noProxy: '' },
    ]);
    expect(undiciMocks.dispatcherArgs).toHaveLength(1);
    expect(undiciMocks.dispatcherArgs[0]).toBeInstanceOf(
      undiciMocks.FakeEnvHttpProxyAgent,
    );
  });

  it("coerces blank proxy vars to '' so undici cannot fall back to raw env", async () => {
    // A blank HTTP_PROXY resolves to undefined; if that reached undici as
    // undefined, EnvHttpProxyAgent would re-read the raw (blank) env var and
    // construct an invalid ProxyAgent URI, failing the whole setup.
    process.env.HTTPS_PROXY = 'http://real:1';
    process.env.HTTP_PROXY = '   ';

    await setupOutboundProxy();

    expect(undiciMocks.agentOpts).toEqual([
      { httpsProxy: 'http://real:1', httpProxy: '', noProxy: '' },
    ]);
  });

  it('installs nothing when no proxy is configured', async () => {
    process.env.NO_PROXY = 'localhost';

    await setupOutboundProxy();

    expect(undiciMocks.agentOpts).toHaveLength(0);
    expect(undiciMocks.dispatcherArgs).toHaveLength(0);
    expect(info).not.toHaveBeenCalled();
  });

  it('logs sanitized proxy URLs without credentials', async () => {
    process.env.HTTPS_PROXY = 'http://user:secret@proxy.internal:8080';
    process.env.NO_PROXY = 'localhost,127.0.0.1';

    await setupOutboundProxy();

    expect(info).toHaveBeenCalledTimes(1);
    const context = info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(context.httpsProxy).toBe('http://proxy.internal:8080');
    expect(context.httpProxy).toBeUndefined();
    expect(context.noProxy).toBe('localhost,127.0.0.1');
    // Belt and braces: the serialized log call must not contain the password.
    expect(JSON.stringify(info.mock.calls)).not.toContain('secret');
  });
});
