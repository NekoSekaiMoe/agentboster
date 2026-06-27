import { ofetch } from 'ofetch';
import type { CliDeployment } from './config';

/**
 * Build an authenticated ofetch instance for a given deployment.
 * Bearer token is added to every request automatically.
 */
export function createApiClient(deployment: CliDeployment) {
  return ofetch.create({
    baseURL: deployment.baseUrl.replace(/\/$/, ''),
    headers: {
      Authorization: `Bearer ${deployment.token}`,
    },
    retry: false,
  });
}

/**
 * Unauthenticated client for the login endpoint (no token yet).
 */
export function createAnonymousApiClient(baseUrl: string) {
  return ofetch.create({
    baseURL: baseUrl.replace(/\/$/, ''),
    retry: false,
  });
}

export type LoginResponse = {
  ok: boolean;
  token?: string;
  expiresAt?: number;
  user?: { id: string; username: string };
  error?: string;
};

/**
 * Native fetch wrapper for streaming SSE — ofetch buffers responses,
 * which is the wrong behavior for /api/ai. Use this for SSE endpoints.
 */
export function createStreamFetcher(deployment: CliDeployment) {
  const baseUrl = deployment.baseUrl.replace(/\/$/, '');
  return (path: string, init?: RequestInit) =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${deployment.token}`,
        ...(init?.headers ?? {}),
      },
    });
}

export { ofetch };
