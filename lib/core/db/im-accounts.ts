import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/core/db';
import { imAccounts } from '@/lib/core/db/schema';
import type { AdapterName } from '@/types/config/channels';

export interface ImAccountRecord {
  id: string;
  clawlessUserId: string;
  adapter: string;
  imUserId: string;
  imUserName: string | null;
  pairedAt: Date;
  unpairedAt: Date | null;
}

function toRecord(row: typeof imAccounts.$inferSelect): ImAccountRecord {
  return {
    id: row.id,
    clawlessUserId: row.clawlessUserId,
    adapter: row.adapter,
    imUserId: row.imUserId,
    imUserName: row.imUserName,
    pairedAt: row.pairedAt,
    unpairedAt: row.unpairedAt,
  };
}

export async function pairImAccount(input: {
  clawlessUserId: string;
  adapter: AdapterName;
  imUserId: string;
  imUserName?: string | null;
}): Promise<ImAccountRecord> {
  const [existing] = await db
    .select()
    .from(imAccounts)
    .where(
      and(
        eq(imAccounts.adapter, input.adapter),
        eq(imAccounts.imUserId, input.imUserId),
      ),
    )
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(imAccounts)
      .set({
        clawlessUserId: input.clawlessUserId,
        imUserName: input.imUserName ?? existing.imUserName,
        pairedAt: new Date(),
        unpairedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(imAccounts.id, existing.id))
      .returning();
    return toRecord(updated ?? existing);
  }

  const [inserted] = await db
    .insert(imAccounts)
    .values({
      clawlessUserId: input.clawlessUserId,
      adapter: input.adapter,
      imUserId: input.imUserId,
      imUserName: input.imUserName ?? null,
    })
    .returning();

  if (!inserted) {
    throw new Error('Failed to pair IM account.');
  }
  return toRecord(inserted);
}

export async function unpairImAccount(input: {
  adapter: AdapterName;
  imUserId: string;
}): Promise<boolean> {
  const [updated] = await db
    .update(imAccounts)
    .set({
      unpairedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(imAccounts.adapter, input.adapter),
        eq(imAccounts.imUserId, input.imUserId),
        isNull(imAccounts.unpairedAt),
      ),
    )
    .returning();
  return Boolean(updated);
}

export async function unpairImAccountByClawlessUser(input: {
  clawlessUserId: string;
  adapter: AdapterName;
}): Promise<boolean> {
  const [updated] = await db
    .update(imAccounts)
    .set({
      unpairedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(imAccounts.clawlessUserId, input.clawlessUserId),
        eq(imAccounts.adapter, input.adapter),
        isNull(imAccounts.unpairedAt),
      ),
    )
    .returning();
  return Boolean(updated);
}

export async function resolveClawLessUserId(
  adapter: AdapterName,
  imUserId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ clawlessUserId: imAccounts.clawlessUserId })
    .from(imAccounts)
    .where(
      and(
        eq(imAccounts.adapter, adapter),
        eq(imAccounts.imUserId, imUserId),
        isNull(imAccounts.unpairedAt),
      ),
    )
    .limit(1);
  return row?.clawlessUserId ?? null;
}

export async function getImAccount(
  adapter: AdapterName,
  imUserId: string,
): Promise<ImAccountRecord | null> {
  const [row] = await db
    .select()
    .from(imAccounts)
    .where(
      and(eq(imAccounts.adapter, adapter), eq(imAccounts.imUserId, imUserId)),
    )
    .limit(1);
  return row ? toRecord(row) : null;
}

export async function listImAccountsForUser(
  clawlessUserId: string,
): Promise<ImAccountRecord[]> {
  const rows = await db
    .select()
    .from(imAccounts)
    .where(
      and(
        eq(imAccounts.clawlessUserId, clawlessUserId),
        isNull(imAccounts.unpairedAt),
      ),
    )
    .orderBy(desc(imAccounts.pairedAt));
  return rows.map(toRecord);
}
