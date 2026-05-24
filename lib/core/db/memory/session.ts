import { db, schema } from '@/lib/core/db';
import { and, desc, eq, sql } from 'drizzle-orm';

export async function getCurrentSessionSummaryRow(sessionId: string) {
  const [row] = await db
    .select()
    .from(schema.sessionMemories)
    .where(
      and(
        eq(schema.sessionMemories.sessionId, sessionId),
        eq(schema.sessionMemories.isCurrent, true),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function listSessionSummaryRows(sessionId: string) {
  return db
    .select()
    .from(schema.sessionMemories)
    .where(eq(schema.sessionMemories.sessionId, sessionId))
    .orderBy(desc(schema.sessionMemories.summaryVersion));
}

export async function saveSessionSummaryRow(
  sessionId: string,
  summaryText: string,
) {
  const [row] = await db.transaction(async (tx) => {
    await tx
      .update(schema.sessionMemories)
      .set({ isCurrent: false })
      .where(
        and(
          eq(schema.sessionMemories.sessionId, sessionId),
          eq(schema.sessionMemories.isCurrent, true),
        ),
      );

    const [latest] = await tx
      .select({
        maxVersion: sql<number>`coalesce(max(${schema.sessionMemories.summaryVersion}), 0)`,
      })
      .from(schema.sessionMemories)
      .where(eq(schema.sessionMemories.sessionId, sessionId));

    const nextVersion = (latest?.maxVersion ?? 0) + 1;

    return tx
      .insert(schema.sessionMemories)
      .values({
        sessionId,
        content: summaryText,
        summaryVersion: nextVersion,
        isCurrent: true,
      })
      .returning();
  });

  return row;
}

export async function clearCurrentSessionSummaryRow(sessionId: string) {
  await db
    .update(schema.sessionMemories)
    .set({ isCurrent: false })
    .where(
      and(
        eq(schema.sessionMemories.sessionId, sessionId),
        eq(schema.sessionMemories.isCurrent, true),
      ),
    );
}
