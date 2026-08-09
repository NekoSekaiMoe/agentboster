import { db, schema } from '@/lib/core/db';
import type { BuiltinMemoryKey } from '@/types/memory';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * Builtin memories (SOUL / IDENTITY / AGENTS / USER prompts) are scoped
 * per-workspace: each workspace gets its own row cloned from the global
 * template (workspace_id IS NULL) on creation, and evolves it independently
 * thereafter. Recall falls through to the global template when a workspace
 * has no override (see {@link getBuiltinMemoryRow}).
 */

/** Global template rows (workspace_id IS NULL) — the system defaults. */
export async function listGlobalBuiltinMemoryRows() {
  return db
    .select()
    .from(schema.builtinMemories)
    .where(isNull(schema.builtinMemories.workspaceId));
}

/**
 * Resolve a builtin memory row for a workspace, falling back to the global
 * template when the workspace has no override. This makes the global rows
 * act as defaults that a workspace can selectively override per-key.
 */
export async function getBuiltinMemoryRow(
  key: BuiltinMemoryKey,
  workspaceId?: string | null,
) {
  if (workspaceId) {
    const [wsRow] = await db
      .select()
      .from(schema.builtinMemories)
      .where(
        and(
          eq(schema.builtinMemories.key, key),
          eq(schema.builtinMemories.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (wsRow) return wsRow;
  }
  // Fall back to the global template.
  const [globalRow] = await db
    .select()
    .from(schema.builtinMemories)
    .where(
      and(
        eq(schema.builtinMemories.key, key),
        isNull(schema.builtinMemories.workspaceId),
      ),
    )
    .limit(1);
  return globalRow ?? null;
}

/**
 * List every builtin row (all workspaces + global templates). Used by the
 * admin memory UI.
 */
export async function listBuiltinMemoryRows() {
  return db.select().from(schema.builtinMemories);
}

/**
 * Upsert a builtin memory row for a specific workspace (or the global
 * template when workspaceId is null/undefined).
 */
export async function upsertBuiltinMemoryRow(
  key: BuiltinMemoryKey,
  content: string,
  workspaceId?: string | null,
) {
  const targetWorkspaceId = workspaceId ?? null;
  const [row] = await db
    .insert(schema.builtinMemories)
    .values({
      key,
      content,
      workspaceId: targetWorkspaceId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [schema.builtinMemories.workspaceId, schema.builtinMemories.key],
      set: { content, updatedAt: new Date() },
    })
    .returning();

  return row;
}

/**
 * Clone the global template rows (workspace_id IS NULL) into a freshly
 * created workspace. Idempotent via ON CONFLICT — safe to call on every
 * workspace creation, and safe if the migration already ran. Failures are
 * non-fatal: recall falls through to the global rows when a workspace has
 * no override, so a workspace without cloned templates is still usable.
 */
export async function cloneBuiltinTemplates(
  workspaceId: string,
): Promise<void> {
  const globals = await listGlobalBuiltinMemoryRows();
  if (globals.length === 0) return;
  await db
    .insert(schema.builtinMemories)
    .values(
      globals.map((row) => ({
        workspaceId,
        key: row.key,
        content: row.content,
        updatedAt: new Date(),
      })),
    )
    .onConflictDoNothing({
      target: [schema.builtinMemories.workspaceId, schema.builtinMemories.key],
    });
}
