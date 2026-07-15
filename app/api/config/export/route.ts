import { readAuthSessionFromCookies } from '@/lib/auth';
import { getConfig } from '@/lib/core/kv/config';
import { cookies } from 'next/headers';

/**
 * Private-data export headers: the config blob carries channel bot tokens,
 * MCP auth headers, and provider API keys, so it must never be cached by
 * the browser, a proxy, or a CDN.
 */
const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
} as const;

const SECRET_KEY_PATTERN = /token|secret|password|api[_-]?key|key|authorization/i;
const REDACTED = '***REDACTED***';

/**
 * Recursively redact secret-looking values from the config. AppConfig nests
 * secrets in several places (channels.*.botToken, mcp.*.headers.Authorization,
 * models provider apiKey, etc.), so a shallow channels-only pass is not
 * enough — we walk the whole tree and redact any string whose key name looks
 * like a credential.
 */
function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (typeof val === 'string' && SECRET_KEY_PATTERN.test(key)) {
        out[key] = val.length > 0 ? REDACTED : val;
      } else {
        out[key] = redactSecrets(val);
      }
    }
    return out;
  }
  return value;
}

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const authSession = await readAuthSessionFromCookies(cookieStore);
  if (!authSession) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const config = await getConfig();

  // Redact by default. An explicit ?redact=false opt-out lets an operator
  // pull a full backup, but the safe path (what a UI button hits) is redacted.
  const url = new URL(request.url);
  const shouldRedact = url.searchParams.get('redact') !== 'false';

  const exportData = {
    exportedAt: new Date().toISOString(),
    version: 1,
    redacted: shouldRedact,
    config: shouldRedact ? redactSecrets(config) : config,
  };

  const filename = `config-${new Date().toISOString().slice(0, 10)}.json`;

  return new Response(JSON.stringify(exportData, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
      ...NO_STORE_HEADERS,
    },
  });
}
