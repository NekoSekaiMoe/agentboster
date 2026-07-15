import { AuthError, requireAuthAccess } from '@/lib/auth/access';
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

const SECRET_KEY_PATTERN =
  /token|secret|password|api[_-]?key|key|authorization/i;
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
  let access: Awaited<ReturnType<typeof requireAuthAccess>>;
  try {
    access = await requireAuthAccess(cookieStore);
  } catch (error) {
    // Only map explicit auth failures to their status; let anything else
    // (e.g. a DB error inside requireAuthAccess) bubble up as a 5xx.
    if (error instanceof AuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  const config = await getConfig();

  // Redact by default. An explicit ?redact=false opt-out returns the raw
  // config (plaintext bot tokens / API keys), so it is admin-only — a
  // non-admin logged-in user always gets the redacted view regardless of
  // the query param. The safe path (what a UI button hits) is redacted.
  const url = new URL(request.url);
  const wantRaw = url.searchParams.get('redact') === 'false';
  const shouldRedact = !(wantRaw && access.isAdmin);

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
