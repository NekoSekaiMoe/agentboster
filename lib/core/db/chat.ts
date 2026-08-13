import type {
  PersistedMessageRecord,
  SerializedMessageForDB,
} from '@/lib/chat/message-utils';
import { db, schema } from '@/lib/core/db';
import { createLogger } from '@/lib/utils/logger';
import { and, asc, count, desc, eq, inArray, or, sql } from 'drizzle-orm';

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
  /** Workspace scope. When omitted, the caller resolves the user's default
   *  workspace elsewhere; this only persists what was already decided. */
  workspaceId?: string | null;
  /** Session visibility inside a PUBLIC workspace (see schema comment).
   *  Defaults to 'private' server-side. */
  visibility?: 'private' | 'shared';
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
      workspaceId: input.workspaceId ?? null,
      ...(input.visibility ? { visibility: input.visibility } : {}),
      model: input.model ?? null,
      systemPrompt: input.systemPrompt ?? null,
      workflowRunId: input.workflowRunId ?? null,
      totalTokens: input.totalTokens ?? 0,
      // Stamp projectId into metadata so the legacy recall path (which reads
      // session.metadata.projectId) stays aligned with the new workspace_id
      // column. The two are the same value; projectId is the historical name.
      // Only overwrite when workspaceId was explicitly provided (including
      // explicit null to clear it). When workspaceId is omitted entirely,
      // preserve whatever projectId the caller put in metadata.
      metadata:
        input.workspaceId !== undefined
          ? ({
              ...(input.metadata ?? {}),
              projectId: input.workspaceId,
            } as SessionMetadata)
          : (input.metadata ?? null),
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
  offset?: number;
  userId?: string;
  workspaceId?: string;
}) {
  const safeLimit = Math.max(1, Math.min(options?.limit ?? 50, 200));
  const safeOffset = Math.max(0, options?.offset ?? 0);
  const conditions: ReturnType<typeof eq>[] = [];
  if (options?.userId) {
    conditions.push(eq(schema.sessions.userId, options.userId));
  }
  if (options?.workspaceId) {
    conditions.push(eq(schema.sessions.workspaceId, options.workspaceId));
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
    .limit(safeLimit)
    .offset(safeOffset);
}

/**
 * Access-aware session listing for the web UI. A row is visible when ANY
 * of these holds:
 *   - the actor owns it (`s.user_id = userId`);
 *   - it lives in a workspace the actor can MANAGE (owner/admin — they see
 *     members' private sessions in lists for management, but still cannot
 *     read message content; the read gate enforces that);
 *   - it lives in a PUBLIC workspace the actor can access AND the session
 *     is `visibility = 'shared'`.
 * The caller computes the two id sets via `listVisibleWorkspaces` /
 * `resolveWorkspaceAccess`. Rows the actor cannot READ are annotated
 * `manageOnly: true` so the UI renders a lock instead of a link.
 */
export async function listVisibleSessions(options: {
  userId: string;
  /** Workspaces the actor can manage (own + admin-manageable). */
  manageableWorkspaceIds: string[];
  /** PUBLIC workspaces the actor can access but not manage. */
  accessiblePublicWorkspaceIds: string[];
  channel?: string;
  archived?: boolean;
  limit?: number;
  /** Rows to skip after ORDER BY (updatedAt DESC). Best-effort paging —
   *  updatedAt is mutable, so a cursor would be more stable, but offset
   *  is adequate for UI paging. */
  offset?: number;
  /** Restrict the listing to a single workspace (applied in SQL, before
   *  ORDER BY/LIMIT, so workspace-scoped callers get a full page). */
  workspaceId?: string;
}) {
  const safeLimit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const safeOffset = Math.max(0, options.offset ?? 0);
  const accessible = options.accessiblePublicWorkspaceIds;
  const manageable = options.manageableWorkspaceIds;

  const visibilityClause = sql`(
    ${schema.sessions.userId} = ${options.userId}
    ${
      manageable.length > 0
        ? sql`OR ${schema.sessions.workspaceId} IN (${sql.join(
            manageable.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : sql``
    }
    ${
      accessible.length > 0
        ? sql`OR (
            ${schema.sessions.workspaceId} IN (${sql.join(
              accessible.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})
            AND ${schema.sessions.visibility} = 'shared'
          )`
        : sql``
    }
  )`;

  const conditions = [visibilityClause];
  if (options.channel) {
    conditions.push(sql`${schema.sessions.channel} = ${options.channel}`);
  }
  if (options.archived !== undefined) {
    conditions.push(sql`${schema.sessions.archived} = ${options.archived}`);
  }
  if (options.workspaceId) {
    conditions.push(
      sql`${schema.sessions.workspaceId} = ${options.workspaceId}::uuid`,
    );
  }

  const rows = await db
    .select()
    .from(schema.sessions)
    .where(and(...conditions))
    .orderBy(desc(schema.sessions.updatedAt))
    .limit(safeLimit)
    .offset(safeOffset);

  const manageableSet = new Set(manageable);
  return rows.map((row) => ({
    ...row,
    /** True when the actor may manage (rename/delete) but NOT read the
     *  message content: other members' private sessions inside a
     *  manageable workspace. */
    manageOnly:
      row.userId !== options.userId &&
      row.visibility !== 'shared' &&
      row.workspaceId !== null &&
      manageableSet.has(row.workspaceId),
  }));
}

/**
 * Hard-delete every session in a workspace. messages, session_memories,
 * files, scheduled and agent_orchestration_plans rows cascade via FK;
 * the session-scoped tables WITHOUT any FK (agent_tasks,
 * agent_task_outputs, agent_tool_activity_logs, agent_barriers,
 * agent_handoffs, agent_subagent_batches, agent_subagent_jobs,
 * l2_decisions) are wiped explicitly first so they don't orphan.
 *
 * Why no db.transaction(): the Vercel driver is drizzle-orm/neon-http,
 * which throws "No transactions support in neon-http driver" (same
 * constraint as setDefaultWorkspace's clear-then-set pair), and
 * node-postgres has no portable db.batch(). Sequential deletes are the
 * portable shape; a mid-flight failure leaves orphans that the caller's
 * retry cleans up, since the session-id list is re-derived each call.
 *
 * Returns the deleted session ids so the caller can best-effort stop
 * runtimes / clean remote state.
 */
export async function deleteSessionsByWorkspaceId(
  workspaceId: string,
): Promise<string[]> {
  const sessionRows = await db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(eq(schema.sessions.workspaceId, workspaceId));
  const sessionIds = sessionRows.map((row) => row.id);
  if (sessionIds.length === 0) {
    return [];
  }

  // Bound every inArray below: a workspace can hold more sessions than
  // Postgres' single-statement parameter limit (65535), so delete in
  // fixed-size batches.
  const BATCH_SIZE = 1000;
  const deletedIds: string[] = [];
  for (let i = 0; i < sessionIds.length; i += BATCH_SIZE) {
    const batch = sessionIds.slice(i, i + BATCH_SIZE);

    await db
      .delete(schema.agentTasks)
      .where(inArray(schema.agentTasks.sessionId, batch));
    await db
      .delete(schema.agentTaskOutputs)
      .where(inArray(schema.agentTaskOutputs.sessionId, batch));
    await db
      .delete(schema.agentToolActivityLogs)
      .where(inArray(schema.agentToolActivityLogs.sessionId, batch));
    await db
      .delete(schema.agentBarriers)
      .where(inArray(schema.agentBarriers.sessionId, batch));
    // Handoffs link TWO session columns — a row is session-scoped when
    // either endpoint belongs to a deleted session.
    await db
      .delete(schema.agentHandoffs)
      .where(
        or(
          inArray(schema.agentHandoffs.fromSessionId, batch),
          inArray(schema.agentHandoffs.toSessionId, batch),
        ),
      );
    await db
      .delete(schema.agentSubagentBatches)
      .where(inArray(schema.agentSubagentBatches.sessionId, batch));
    await db
      .delete(schema.agentSubagentJobs)
      .where(inArray(schema.agentSubagentJobs.sessionId, batch));
    // l2_decisions.session_id is text (not uuid), unlike the tables above.
    await db
      .delete(schema.l2Decisions)
      .where(inArray(schema.l2Decisions.sessionId, batch));

    // Delete only the ids selected above — NOT eq(workspaceId): sessions
    // created after the initial select have no dependent-row cleanup in
    // this run and must survive for the caller's retry instead of being
    // deleted with orphans left behind.
    const rows = await db
      .delete(schema.sessions)
      .where(inArray(schema.sessions.id, batch))
      .returning({ id: schema.sessions.id });
    deletedIds.push(...rows.map((row) => row.id));
  }
  return deletedIds;
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
  value: string | boolean | null,
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
  // - new_value: to_jsonb(<str>::text) → JSON string;
  //   to_jsonb(<bool>::boolean) → JSON boolean (e.g. the pinned toggle);
  //   or 'null'::jsonb → the JSONB null literal when value is null. Do
  //   NOT use to_jsonb(NULL::text) — that yields SQL NULL, which
  //   jsonb_set would propagate to the whole target column instead of
  //   just one key.
  const pathLiteral = `{${key}}`;
  const newValue =
    value === null
      ? sql`'null'::jsonb`
      : typeof value === 'boolean'
        ? sql`to_jsonb(${value}::boolean)`
        : sql`to_jsonb(${value}::text)`;

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

// ── Session Goal DAL ──────────────────────────────────────────────
// Persisted counters for the self-driving loop (see
// lib/workflow/agent/session-goal.ts). A new goal = fresh counters; the
// no-progress breaker relies on the reset semantics below.

/** Shape returned by getSessionGoalState — exactly the fields the
 *  continuation gate reads. */
export interface SessionGoalState {
  goalText: string | null;
  hiddenCount: number;
  consecutiveNonProgress: number;
  lastEvalReason: string | null;
}

/** State passed into incrementGoalCounters. Any field may be omitted /
 *  left at its default; the matching column is left untouched. */
export interface GoalCounterDelta {
  /** Delta to apply to hidden_continuation_count (e.g. +1 on a
   *  continuation). 0 = leave unchanged. */
  hiddenDelta?: number;
  /** Delta to apply to consecutive_non_progress. The caller decides
   *  whether the latest evaluation counts as "non-progress": pass +1
   *  when the reason is identical to the previous one, else 0 (and
   *  reset to 0 when the reason changes — see clearSessionGoal + a
   *  bare hiddenDelta-only call below). */
  nonProgressDelta?: number;
  /** New value for last_eval_reason. When provided, overwrites the
   *  column; when omitted, the column is left as-is. */
  lastEvalReason?: string | null;
}

/**
 * Set (or replace) the session goal. Writes goal_text + goal_set_at and
 * RESETS hidden_continuation_count / consecutive_non_progress /
 * last_eval_reason — a new objective starts every counter from zero so
 * the MAX_HIDDEN_CONTINUATIONS (8) and MAX_IDENTICAL_NON_PROGRESS (2)
 * breakers measure effort against THIS goal, not history.
 */
export async function setSessionGoal(
  sessionId: string,
  goalText: string,
): Promise<typeof schema.sessions.$inferSelect | null> {
  const [session] = await db
    .update(schema.sessions)
    .set({
      goalText,
      goalSetAt: new Date(),
      // New goal = fresh counters. The breaker scopes are per-goal.
      hiddenContinuationCount: 0,
      consecutiveNonProgress: 0,
      lastEvalReason: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.sessions.id, sessionId))
    .returning();

  return session ?? null;
}

/**
 * Clear the session goal. Nulls goal_text / goal_set_at /
 * last_eval_reason and zeroes the counters. Idempotent: clearing a
 * session that has no goal is a no-op write.
 */
export async function clearSessionGoal(
  sessionId: string,
): Promise<typeof schema.sessions.$inferSelect | null> {
  const [session] = await db
    .update(schema.sessions)
    .set({
      goalText: null,
      goalSetAt: null,
      hiddenContinuationCount: 0,
      consecutiveNonProgress: 0,
      lastEvalReason: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.sessions.id, sessionId))
    .returning();

  return session ?? null;
}

/**
 * Atomically bump the goal counters and (optionally) overwrite
 * last_eval_reason. Uses SQL-side `= col + n` so two concurrent
 * evaluations can't lose an increment via read-modify-write. The
 * columns are NOT NULL with default 0, so the COALESCE guard is purely
 * defensive against a pre-migration row.
 *
 * Deltas default to 0 (no change); lastEvalReason defaults to
 * undefined (leave the column as-is). Pass lastEvalReason explicitly
 * (including `null`) to update it.
 */
export async function incrementGoalCounters(
  sessionId: string,
  delta: GoalCounterDelta,
): Promise<typeof schema.sessions.$inferSelect | null> {
  const patch: Partial<typeof schema.sessions.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (delta.hiddenDelta) {
    // Drizzle accepts a SQL expression for an update SET value (it
    // serializes to "col = col + n" at the driver layer), but the TS
    // $inferInsert type narrows to a literal number, so the SQL wrapper
    // needs a cast. This is the documented Drizzle escape hatch.
    patch.hiddenContinuationCount =
      sql`${schema.sessions.hiddenContinuationCount} + ${delta.hiddenDelta}` as unknown as number;
  }
  if (delta.nonProgressDelta) {
    patch.consecutiveNonProgress =
      sql`${schema.sessions.consecutiveNonProgress} + ${delta.nonProgressDelta}` as unknown as number;
  }
  if (delta.lastEvalReason !== undefined) {
    patch.lastEvalReason = delta.lastEvalReason;
  }

  const [session] = await db
    .update(schema.sessions)
    .set(patch)
    .where(eq(schema.sessions.id, sessionId))
    .returning();

  return session ?? null;
}

/**
 * Read exactly the fields the continuation gate consumes. Returns a
 * normalized shape (goalText null = no goal set → caller skips the
 * whole loop). Returns all-null/zero when the session doesn't exist.
 */
export async function getSessionGoalState(
  sessionId: string,
): Promise<SessionGoalState> {
  const [row] = await db
    .select({
      goalText: schema.sessions.goalText,
      hiddenContinuationCount: schema.sessions.hiddenContinuationCount,
      consecutiveNonProgress: schema.sessions.consecutiveNonProgress,
      lastEvalReason: schema.sessions.lastEvalReason,
    })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .limit(1);

  if (!row) {
    return {
      goalText: null,
      hiddenCount: 0,
      consecutiveNonProgress: 0,
      lastEvalReason: null,
    };
  }

  return {
    goalText: row.goalText,
    hiddenCount: row.hiddenContinuationCount ?? 0,
    consecutiveNonProgress: row.consecutiveNonProgress ?? 0,
    lastEvalReason: row.lastEvalReason,
  };
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
