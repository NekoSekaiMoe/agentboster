import { db, schema } from '@/lib/core/db';
import { atomicWriteMode } from '@/lib/core/db/atomic';
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
  // The next summary version is computed in SQL via a correlated subquery
  // so the batch is self-contained (the neon batch API is non-interactive
  // — it cannot read between statements).
  const nextVersionSql = sql<number>`(
    SELECT coalesce(max(${schema.sessionMemories.summaryVersion}), 0) + 1
    FROM ${schema.sessionMemories}
    WHERE ${schema.sessionMemories.sessionId} = ${sessionId}
  )`;

  if (atomicWriteMode() === 'neon') {
    // neon-http: db.batch is the atomic primitive. db.transaction throws
    // 'No transactions support in neon-http driver'.
    const [, insertedRows] = await db.batch([
      db
        .update(schema.sessionMemories)
        .set({ isCurrent: false })
        .where(
          and(
            eq(schema.sessionMemories.sessionId, sessionId),
            eq(schema.sessionMemories.isCurrent, true),
          ),
        ),
      db
        .insert(schema.sessionMemories)
        .values({
          sessionId,
          content: summaryText,
          summaryVersion: nextVersionSql,
          isCurrent: true,
        })
        .returning(),
    ]);
    return insertedRows[0];
  }

  // node-postgres: db.transaction is the atomic primitive. db.batch is
  // undefined on NodePgDatabase.
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

    return tx
      .insert(schema.sessionMemories)
      .values({
        sessionId,
        content: summaryText,
        summaryVersion: nextVersionSql,
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
