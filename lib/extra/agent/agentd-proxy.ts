/**
 * Shared helper for proxying subagent/advisor/checkpoint requests to agentd.
 *
 * Resolves the agentd node URL from AGENTD_URL env var (matching the
 * existing exec-on-agentd pattern), builds the HTTP config, and forwards
 * the request. Falls back to DB queries when agentd is not reachable.
 */

import { buildAgentdHttpConfig } from '@/lib/extra/agent/agentd-tools-client';
import { requestAgentd } from '@/lib/extra/agent/agentd-http';

export async function proxyGetToAgentd(
  path: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const baseUrl = process.env.AGENTD_URL;
  if (!baseUrl) {
    return {
      ok: false,
      status: 503,
      data: { error: 'AGENTD_URL not configured' },
    };
  }

  try {
    const config = await buildAgentdHttpConfig(baseUrl);
    const response = await requestAgentd(config, 'GET', path);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data: { error: response.text },
      };
    }
    const parsed = JSON.parse(response.text);
    return { ok: true, status: 200, data: parsed.data ?? parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 502,
      data: { error: `agentd unreachable: ${message}` },
    };
  }
}

export async function proxyPostToAgentd(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const baseUrl = process.env.AGENTD_URL;
  if (!baseUrl) {
    return {
      ok: false,
      status: 503,
      data: { error: 'AGENTD_URL not configured' },
    };
  }

  try {
    const config = await buildAgentdHttpConfig(baseUrl);
    const response = await requestAgentd(config, 'POST', path, body);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data: { error: response.text },
      };
    }
    const parsed = JSON.parse(response.text);
    return { ok: true, status: 200, data: parsed.data ?? parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 502,
      data: { error: `agentd unreachable: ${message}` },
    };
  }
}
