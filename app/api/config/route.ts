import { readAuthSessionFromCookies } from '@/lib/auth';
import { getConfig } from '@/lib/core/kv/config';
import { cookies } from 'next/headers';

/**
 * Read-only access to the running AppConfig for authenticated clients.
 *
 * Used by chat components (e.g. TTS auto-play toggle) that need to know
 * server-side feature flags without the ConfigProvider dance. Mutations
 * happen through the config dashboard's PATCH endpoint, not here.
 */
export async function GET() {
  const cookieStore = await cookies();
  const authSession = await readAuthSessionFromCookies(cookieStore);
  if (!authSession) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const config = await getConfig();
  return Response.json(config, {
    headers: { 'cache-control': 'no-store' },
  });
}
