import { eq } from 'drizzle-orm';
import { db } from '@/lib/core/db';
import { users } from '@/lib/core/db/schema';
import { verifyPassword } from '@/lib/auth/password';

export async function validateCredentials(params: {
  username: string;
  password: string;
}): Promise<{ id: string; username: string } | null> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.username, params.username))
    .limit(1);

  if (rows.length === 0) return null;

  const isValid = await verifyPassword(params.password, rows[0].passwordHash);
  if (!isValid) return null;

  return { id: rows[0].id, username: rows[0].username };
}
