export const dynamic = 'force-dynamic';

import { listVaultKeyNames } from '@/lib/extra/vault';

export async function GET() {
  const keys = await listVaultKeyNames();
  return Response.json({ success: true, data: { keys } });
}
