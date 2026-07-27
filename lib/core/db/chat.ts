import type {
  PersistedMessageRecord,
  SerializedMessageForDB,
} from '@/lib/chat/message-utils';
import { db, schema } from '@/lib/core/db';
import { createLogger } from '@/lib/utils/logger';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';

const logger = createLogger('db.chat');

type SessionMetadata = Record<string, unknown> | null | undefined;

function toPersistedMessageRecord(
  row: typeof schema.messages.$inferSelect,
): PersistedMessageRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    uiMessageId: row.uiMessageId,
    visibleInChat: row.visibleInChat,
    stepNumber: row.stepNumber,
    payload: row.payload,
    createdAt: row.createdAt,
  };
}

export async function createSession(input: {
  id?: string;
  title?: string | null;
  channel?: string;
  externalThreadId?: string | null;
  userId?: string | null;
  model?: string | null;
  systemPrompt?: string | null;
  workflowRunId?: string | null;
  totalTokens?: number;
  metadata?: SessionMetadata;
}) {
  const [session] = await db
    .insert(schema.sessions)
    .values({
      ...(input.id ? { id: input.id } : {}),
      title: input.title ?? null,
      channel: input.channel ?? 'web',
      externalThreadId: input.externalThreadId ?? null,
      userId: input.userId ?? null,
      model: input.model ?? null,
      systemPrompt: input.systemPrompt ?? null,
      workflowRunId: input.workflowRunId ?? null,
      totalTokens: input.totalTokens ?? 0,
      metadata: input.metadata ?? null,
    })
    .returning();

  if (!session) {
    throw new Error('Failed to create session.');
  }

  return session;
}

export async function getSession(
  sessionId: string,
  options?: { userId?: string },
) {
  const conditions = [eq(schema.sessions.id, sessionId)];
  if (options?.userId) {
    conditions.push(eq(schema.sessions.userId, options.userId));
  }

  const [session] = await db
    .select()
    .from(schema.sessions)
    .where(and(...conditions))
    .limit(1);

  return session ?? null;
}

export async function getSessionByExternalThreadId(externalThreadId: string) {
  const [session] = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.externalThreadId, externalThreadId))
    .limit(1);

  return session ?? null;
}

export async function listSessionsByExternalThreadIds(
  externalThreadIds: string[],
) {
  const ids = externalThreadIds
    .map((value) => value.trim())
    .filter(
      (value, index, array) =>
        value.length > 0 && array.indexOf(value) === index,
    );

  if (ids.length === 0) {
    return [];
  }

  return db
    .select()
    .from(schema.sessions)
    .where(inArray(schema.sessions.externalThreadId, ids));
}

export async function getSessionByWorkflowRunId(runId: string) {
  const [session] = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.workflowRunId, runId))
    .limit(1);

  return session ?? null;
}

export async function listSessions(options?: {
  channel?: string;
  archived?: boolean;
  limit?: number;
  userId?: string;
}) {
  const safeLimit = Math.max(1, Math.min(options?.limit ?? 50, 200));
  const conditions: ReturnType<typeof eq>[] = [];
  if (options?.userId) {
    conditions.push(eq(schema.sessions.userId, options.userId));
  }
  if (options?.channel) {
    conditions.push(eq(schema.sessions.channel, options.channel));
  }
  if (options?.archived !== undefined) {
    conditions.push(eq(schema.sessions.archived, options.archived));
  }

  return db
    .select()
    .from(schema.sessions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.sessions.updatedAt))
    .limit(safeLimit);
}

export async function updateSession(
  sessionId: string,
  patch: Partial<typeof schema.sessions.$inferInsert>,
) {
  const [session] = await db
    .update(schema.sessions)
    .set({
      ...patch,
      updatedAt: new Date(),
    })
    .where(eq(schema.sessions.id, sessionId))
    .returning();

  return session ?? null;
}

export async function updateSessionForUser(
  sessionId: string,
  userId: string,
  patch: Partial<typeof schema.sessions.$inferInsert>,
) {
  const [session] = await db
    .update(schema.sessions)
    .set({
      ...patch,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.sessions.id, sessionId),
        eq(schema.sessions.userId, userId),
      ),
    )
    .returning();

  return session ?? null;
}

/**
 * Atomically patch a single key on sessions.metadata via jsonb_set, avoiding
 * the read-modify-write race that a full-column `set({ metadata })` has
 * when other writers (workflow contextUsage, approval state, AGENTS.md
 * persistence, …) touch the same jsonb concurrently. `value` is serialized
 * to jsonb server-side; passing `null` stores JSON null into the key
 * (clearing a previously-set value), matching saveSessionPersonaAction's
 * `agent || null` semantics.
 *
 * NOTE: the null branch must produce a JSONB null literal, not SQL NULL.
 * `to_jsonb(NULL::text)` evaluates to SQL NULL (not JSON null), and when
 * passed as jsonb_set's `new_value` it replaces the whole target with SQL
 * NULL — wiping the entire metadata column instead of just one key.
 * `'null'::jsonb` is the correct JSONB null literal.
 *
 * Returns the updated row or null (not-found / owner mismatch).
 */
export async function updateSessionMetadataKey(
  sessionId: string,
  userId: string | null,
  key: string,
  value: string | null,
) {
  // Validate key: jsonb_set's path is a text array literal '{key}', and we
  // build it by interpolation, so the key MUST be a plain identifier to
  // avoid SQL injection. This regex is deliberately strict.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`invalid metadata key: ${key}`);
  }

  const whereClause =
    userId === null
      ? eq(schema.sessions.id, sessionId)
      : and(
          eq(schema.sessions.id, sessionId),
          eq(schema.sessions.userId, userId),
        );

  // jsonb_set(target, text[], new_value, create_if_missing=true).
  // - path: '{key}' as a raw literal (validated above).
  // - new_value: to_jsonb(<str>::text) → JSON string; or 'null'::jsonb →
  //   the JSONB null literal when value is null. Do NOT use
  //   to_jsonb(NULL::text) — that yields SQL NULL, which jsonb_set would
  //   propagate to the whole target column instead of just one key.
  const pathLiteral = `{${key}}`;
  const newValue =
    value === null ? sql`'null'::jsonb` : sql`to_jsonb(${value}::text)`;

  const [session] = await db
    .update(schema.sessions)
    .set({
      metadata: sql`jsonb_set(${schema.sessions.metadata}, ${pathLiteral}::text[], ${newValue}, true)`,
      updatedAt: new Date(),
    })
    .where(whereClause)
    .returning();

  return session ?? null;
}

export async function deleteSession(sessionId: string) {
  const [session] = await db
    .delete(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .returning();

  return session ?? null;
}

export async function deleteSessionForUser(sessionId: string, userId: string) {
  const [session] = await db
    .delete(schema.sessions)
    .where(
      and(
        eq(schema.sessions.id, sessionId),
        eq(schema.sessions.userId, userId),
      ),
    )
    .returning();

  return session ?? null;
}

export async function listUserSessions(options: {
  userId: string;
  limit?: number;
}) {
  const safeLimit = Math.max(1, Math.min(options.limit ?? 50, 200));

  return db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.userId, options.userId))
    .orderBy(desc(schema.sessions.updatedAt))
    .limit(safeLimit);
}

export async function countSessionsByUserIds(userIds: string[]) {
  const ids = [...new Set(userIds.filter((id) => id.trim().length > 0))];
  if (ids.length === 0) {
    return new Map<string, number>();
  }

  const rows = await db
    .select({
      userId: schema.sessions.userId,
      count: count(),
    })
    .from(schema.sessions)
    .where(inArray(schema.sessions.userId, ids))
    .groupBy(schema.sessions.userId);

  return new Map(
    rows
      .filter((row): row is { userId: string; count: number } =>
        Boolean(row.userId),
      )
      .map((row) => [row.userId, Number(row.count)]),
  );
}

export async function saveMessages(messages: SerializedMessageForDB[]) {
  if (messages.length === 0) {
    return [];
  }

  const rows = await db
    .insert(schema.messages)
    .values(
      messages.map((message) => ({
        sessionId: message.sessionId,
        role: message.role,
        uiMessageId: message.uiMessageId ?? null,
        visibleInChat: message.visibleInChat ?? true,
        stepNumber: message.stepNumber ?? null,
        payload: message.payload as Record<string, unknown>,
        createdAt: message.createdAt ?? new Date(),
      })),
    )
    .returning();

  return rows.map(toPersistedMessageRecord);
}

export async function upsertUserMessage(input: SerializedMessageForDB) {
  if (!input.uiMessageId) {
    throw new Error('uiMessageId is required for user message upsert.');
  }

  return upsertPersistedMessage(input);
}

export async function upsertPersistedMessage(input: SerializedMessageForDB) {
  const uiMessageId = input.uiMessageId;
  if (!uiMessageId) {
    throw new Error('uiMessageId is required for persisted message upsert.');
  }

  const [row] = await db
    .insert(schema.messages)
    .values({
      sessionId: input.sessionId,
      role: input.role,
      uiMessageId,
      visibleInChat: input.visibleInChat ?? true,
      stepNumber: input.stepNumber ?? null,
      payload: input.payload as Record<string, unknown>,
      createdAt: input.createdAt ?? new Date(),
    })
    .onConflictDoUpdate({
      target: [schema.messages.sessionId, schema.messages.uiMessageId],
      set: {
        role: input.role,
        payload: input.payload as Record<string, unknown>,
        visibleInChat: input.visibleInChat ?? true,
        stepNumber: input.stepNumber ?? null,
      },
    })
    .returning();

  return row ? toPersistedMessageRecord(row) : null;
}

export async function getSessionMessages(
  sessionId: string,
): Promise<PersistedMessageRecord[]> {
  const rows = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.sessionId, sessionId))
    .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id));

  return rows.map(toPersistedMessageRecord);
}

export async function getVisibleSessionMessages(
  sessionId: string,
): Promise<PersistedMessageRecord[]> {
  const rows = await db
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.sessionId, sessionId),
        eq(schema.messages.visibleInChat, true),
      ),
    )
    .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id));

  return rows.map(toPersistedMessageRecord);
}

export async function getMessageByUiMessageId(
  sessionId: string,
  uiMessageId: string,
): Promise<PersistedMessageRecord | null> {
  const [row] = await db
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.sessionId, sessionId),
        eq(schema.messages.uiMessageId, uiMessageId),
      ),
    )
    .limit(1);

  return row ? toPersistedMessageRecord(row) : null;
}

export async function getFirstVisibleSessionMessage(
  sessionId: string,
): Promise<PersistedMessageRecord | null> {
  const [row] = await db
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.sessionId, sessionId),
        eq(schema.messages.visibleInChat, true),
      ),
    )
    .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id))
    .limit(1);

  return row ? toPersistedMessageRecord(row) : null;
}

export async function getVisibleSessionMessagesPage(
  sessionId: string,
  options?: {
    limit?: number;
    before?: Date;
  },
) {
  const safeLimit = Math.max(1, Math.min(options?.limit ?? 50, 200));

  const rows = await getVisibleSessionMessages(sessionId);
  const before = options?.before;
  const filtered = options?.before
    ? rows.filter((row) => (before ? row.createdAt < before : true))
    : rows;
  const page = filtered.slice(-safeLimit);

  return {
    messages: page,
    hasMore: filtered.length > safeLimit,
    nextBefore: page.length > 0 ? page[0].createdAt.toISOString() : null,
  };
}

export async function deleteMessagesAfterUiMessageId(
  sessionId: string,
  uiMessageId: string,
) {
  const rows = await getSessionMessages(sessionId);
  const pivotIndex = rows.findIndex((row) => row.uiMessageId === uiMessageId);

  if (pivotIndex === -1) {
    return [];
  }

  const ids = rows.slice(pivotIndex + 1).map((row) => row.id);
  if (ids.length === 0) {
    return [];
  }

  logger.info('truncate:messages_after_ui_message', {
    sessionId,
    uiMessageId,
    count: ids.length,
  });

  const deleted: PersistedMessageRecord[] = [];
  for (const id of ids) {
    const [row] = await db
      .delete(schema.messages)
      .where(eq(schema.messages.id, id))
      .returning();
    if (row) {
      deleted.push(toPersistedMessageRecord(row));
    }
  }

  return deleted;
}
