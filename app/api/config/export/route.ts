import { readAuthSessionFromCookies } from '@/lib/auth';
import { getConfig } from '@/lib/core/kv/config';
import { cookies } from 'next/headers';

export async function GET() {
  const cookieStore = await cookies();
  const authSession = await readAuthSessionFromCookies(cookieStore);
  if (!authSession) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const config = await getConfig();

  const exportData = {
    exportedAt: new Date().toISOString(),
    version: 1,
    config,
  };

  const filename = `config-${new Date().toISOString().slice(0, 10)}.json`;

  return new Response(JSON.stringify(exportData, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
