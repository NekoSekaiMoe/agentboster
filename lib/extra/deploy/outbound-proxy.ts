/**
 * Self-hosted outbound HTTP(S) proxy support.
 *
 * Routes ALL outbound fetch traffic (LLM provider calls via the AI SDK,
 * webhook deliveries, etc.) through the proxy configured via the standard
 * `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` environment variables.
 *
 * This mirrors pi's proxy support: on self-hosted deployments behind
 * corporate egress filters, undici's default fetch ignores `HTTP(S)_PROXY`
 * entirely, so provider requests fail unless a dispatcher is installed.
 * `EnvHttpProxyAgent` also implements `NO_PROXY` matching including root
 * domains and subdomains (pi #8737).
 *
 * Placement rules (see AGENTS.md / CLAUDE.md):
 * - Vercel never takes this path — deployment decisions funnel through
 *   `lib/extra/deploy/index.ts`, never inline `process.env.VERCEL` checks.
 * - This module is only imported from `instrumentation.ts` (host-only,
 *   never inside the workflow `vm` sandbox), and the `undici` import is a
 *   dynamic `await import()` inside the function so nothing enters the
 *   workflow steps bundle. `undici` is listed in `serverExternalPackages`.
 *
 * `setGlobalDispatcher` from the npm undici package also affects Node's
 * built-in `globalThis.fetch`: both read the dispatcher from the shared
 * `Symbol.for('undici.globalDispatcher.1')` registry slot, so a single
 * call here covers every fetch in the process.
 */

import { createLogger } from '@/lib/utils/logger';

import { isSelfHosted } from './index';

const logger = createLogger('outbound-proxy');

export type ProxyEnv = Readonly<
  Partial<Record<'HTTPS_PROXY' | 'HTTP_PROXY' | 'NO_PROXY', string>>
>;

/**
 * Resolve the effective proxy env: first non-empty variable of each
 * (UPPER, lower) pair, trimmed. Exported for testing.
 */
export function readProxyEnv(
  env: Readonly<Record<string, string | undefined>>,
): ProxyEnv {
  const pick = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = env[name];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
    return undefined;
  };

  return {
    HTTPS_PROXY: pick('HTTPS_PROXY', 'https_proxy'),
    HTTP_PROXY: pick('HTTP_PROXY', 'http_proxy'),
    NO_PROXY: pick('NO_PROXY', 'no_proxy'),
  };
}

/**
 * Pure decision helper: should a proxy dispatcher be installed for these
 * resolved env values? A proxy is installed when at least one of
 * HTTPS_PROXY / HTTP_PROXY is set (NO_PROXY alone configures nothing).
 */
export function shouldEnableProxy(env: ProxyEnv): boolean {
  return env.HTTPS_PROXY !== undefined || env.HTTP_PROXY !== undefined;
}

/**
 * Install the env-driven proxy dispatcher on the global fetch. Safe to call
 * on any deployment: it no-ops on Vercel and when no proxy variables are
 * configured.
 */
export async function setupOutboundProxy(): Promise<void> {
  if (!isSelfHosted) return;

  const env = readProxyEnv(process.env);
  if (!shouldEnableProxy(env)) return;

  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(new EnvHttpProxyAgent());
    logger.info('outbound proxy enabled', {
      httpsProxy: env.HTTPS_PROXY,
      httpProxy: env.HTTP_PROXY,
      noProxy: env.NO_PROXY,
    });
  } catch (error) {
    // Proxy setup must never block server startup — log and continue with
    // direct egress; individual provider calls will surface their own errors.
    logger.error('failed to enable outbound proxy', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
