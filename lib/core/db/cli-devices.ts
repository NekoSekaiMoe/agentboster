import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/core/db';
import { cliDevices } from '@/lib/core/db/schema';

export type CliDevice = typeof cliDevices.$inferSelect;
export type NewCliDevice = typeof cliDevices.$inferInsert;

export async function createCliDevice(input: {
  clawlessUserId: string;
  label?: string | null;
  tokenJti: string;
}): Promise<CliDevice> {
  const [row] = await db
    .insert(cliDevices)
    .values({
      clawlessUserId: input.clawlessUserId,
      label: input.label ?? null,
      tokenJti: input.tokenJti,
    })
    .returning();
  return row;
}

export async function getCliDeviceByJti(
  jti: string,
): Promise<CliDevice | null> {
  const [row] = await db
    .select()
    .from(cliDevices)
    .where(eq(cliDevices.tokenJti, jti))
    .limit(1);
  return row ?? null;
}

export async function listActiveCliDevicesByUser(
  userId: string,
): Promise<CliDevice[]> {
  return db
    .select()
    .from(cliDevices)
    .where(
      and(eq(cliDevices.clawlessUserId, userId), isNull(cliDevices.revokedAt)),
    )
    .orderBy(desc(cliDevices.pairedAt));
}

export async function listAllCliDevicesByUser(
  userId: string,
): Promise<CliDevice[]> {
  return db
    .select()
    .from(cliDevices)
    .where(eq(cliDevices.clawlessUserId, userId))
    .orderBy(desc(cliDevices.pairedAt));
}

export async function revokeCliDevice(input: {
  deviceId: string;
  userId: string;
}): Promise<CliDevice | null> {
  const [row] = await db
    .update(cliDevices)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(cliDevices.id, input.deviceId),
        eq(cliDevices.clawlessUserId, input.userId),
        isNull(cliDevices.revokedAt),
      ),
    )
    .returning();
  return row ?? null;
}

export async function touchCliDeviceLastSeen(jti: string): Promise<void> {
  await db
    .update(cliDevices)
    .set({ lastSeenAt: new Date() })
    .where(and(eq(cliDevices.tokenJti, jti), isNull(cliDevices.revokedAt)));
}
