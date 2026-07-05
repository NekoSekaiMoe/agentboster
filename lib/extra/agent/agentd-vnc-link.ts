import { createHmac } from 'node:crypto';

const AGENTD_VNC_LINK_VERSION = 'v1';
const AGENTD_VNC_LINK_SCOPE = 'desktop-vnc';
const DEFAULT_TTL_SECONDS = 5 * 60;

function buildMessage(sessionId: string, expires: number): string {
  return [
    AGENTD_VNC_LINK_VERSION,
    AGENTD_VNC_LINK_SCOPE,
    sessionId,
    String(expires),
  ].join(':');
}

export function signAgentdVncLink(input: {
  sessionId: string;
  secret: string;
  nowMs?: number;
  ttlSeconds?: number;
}): { expires: number; signature: string } {
  const nowMs = input.nowMs ?? Date.now();
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const expires = Math.floor(nowMs / 1000) + ttlSeconds;
  const signature = createHmac('sha256', input.secret)
    .update(buildMessage(input.sessionId, expires))
    .digest('hex');
  return { expires, signature };
}

export function buildAgentdDesktopWsUrl(input: {
  baseUrl: string;
  sessionId: string;
  secret: string;
  nowMs?: number;
  ttlSeconds?: number;
}): string {
  const url = new URL('/api/v1/desktop/vnc', input.baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  const { expires, signature } = signAgentdVncLink({
    sessionId: input.sessionId,
    secret: input.secret,
    nowMs: input.nowMs,
    ttlSeconds: input.ttlSeconds,
  });

  url.searchParams.set('session_id', input.sessionId);
  url.searchParams.set('exp', String(expires));
  url.searchParams.set('sig', signature);
  return url.toString();
}
