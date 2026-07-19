/**
 * Deployment-mode detection hub.
 *
 * Every backend-selection decision (DB driver, KV backend, blob backend,
 * public URL derivation) funnels through this module so the rest of the
 * codebase never re-implements "are we on Vercel?" checks inline.
 *
 * IMPORTANT: this file is imported from code paths that may be transitively
 * reachable from the workflow bundle. Keep it free of top-level `node:*`
 * imports and any heavy dependencies — it must stay a pure env-var reader.
 * See CLAUDE.md ("Top-level `node:*` imports break the workflow bundle").
 */

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * True when running on Vercel. We treat the presence of `VERCEL` (set to
 * "1" on every Vercel build/runtime) OR `VERCEL_DEPLOYMENT_ID` (set only at
 * runtime on a real deployment) as authoritative. Either one means "Vercel".
 *
 * Note: this is evaluated once at module load. Vercel always sets `VERCEL=1`
 * across build and runtime, so a single read is safe. Self-hosted / local
 * deployments set neither and fall through to `false`.
 */
export const isVercel: boolean =
  readEnv('VERCEL') === '1' || readEnv('VERCEL_DEPLOYMENT_ID') !== undefined;

/** Convenience inverse — self-hosted (Docker / bare-metal / local dev). */
export const isSelfHosted: boolean = !isVercel;

const LOCAL_BASE_URL = 'http://127.0.0.1:3000';

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function withScheme(host: string): string {
  // Only treat the value as already-schemed when it starts with a
  // complete `http://` or `https://` scheme. A bare host like
  // `http.example.com` would otherwise pass a `startsWith('http')`
  // check and end up with no scheme, breaking URL construction for
  // OAuth callback URIs, blob links, and webhook URLs.
  return /^https?:\/\//i.test(host) ? host : `https://${host}`;
}

/**
 * Resolve the public-facing base URL of the app (no trailing slash).
 *
 * Precedence:
 *   1. PUBLIC_APP_URL              — self-hosted explicit override (any scheme)
 *   2. Vercel production URL       — NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL
 *                                    / VERCEL_PROJECT_PRODUCTION_URL
 *   3. Vercel branch URL           — VERCEL_BRANCH_URL
 *   4. Vercel deployment URL       — VERCEL_URL
 *   5. localhost fallback          — dev / unconfigured self-host
 *
 * PUBLIC_APP_URL wins over everything so a self-hosted operator behind a
 * reverse proxy can pin the exact origin (used for bot webhooks and the
 * blob proxy route). On Vercel the operator normally leaves it unset and
 * the platform-provided URLs take over.
 */
export function getPublicAppUrl(): string {
  const publicAppUrl = readEnv('PUBLIC_APP_URL');
  const productionUrl =
    readEnv('NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL') ??
    readEnv('VERCEL_PROJECT_PRODUCTION_URL');
  const branchUrl = readEnv('VERCEL_BRANCH_URL');
  const vercelUrl = readEnv('VERCEL_URL');

  const baseUrl =
    publicAppUrl ?? productionUrl ?? branchUrl ?? vercelUrl ?? LOCAL_BASE_URL;

  return normalizeBaseUrl(withScheme(baseUrl));
}

/**
 * Whether a public app URL has been explicitly configured (as opposed to
 * silently falling back to localhost). Used by health checks to flag a
 * self-hosted deployment that forgot to set PUBLIC_APP_URL.
 *
 * Note: Vercel preview/deployment URLs (`VERCEL_BRANCH_URL`, `VERCEL_URL`)
 * are intentionally EXCLUDED — they are ephemeral per-deployment URLs and
 * must not be reported as a configured production origin (otherwise OAuth
 * callback URIs and webhook URLs would silently point at a throwaway URL
 * that disappears on the next deploy). Only `PUBLIC_APP_URL` and the
 * Vercel production project URL count.
 */
export function hasConfiguredPublicAppUrl(): boolean {
  return (
    readEnv('PUBLIC_APP_URL') !== undefined ||
    readEnv('NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL') !== undefined ||
    readEnv('VERCEL_PROJECT_PRODUCTION_URL') !== undefined
  );
}
