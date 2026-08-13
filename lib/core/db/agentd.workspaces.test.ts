/**
 * Workspace DAL tests against a REAL in-memory Postgres (PGlite) — same
 * strategy as agent-orchestration-plans.integration.test.ts.
 *
 * What this catches that a hand-rolled mock cannot:
 *   - The workspaces_owner_default_uniq partial unique index actually
 *     rejecting two live defaults (setDefaultWorkspace's clear-then-set
 *     ordering is the only thing keeping that invariant).
 *   - node_generation bump semantics on migrateWorkspaceNode.
 *   - Column-name / dialect errors in the UPDATE statements.
 *
 * The DAL functions import the production `db` singleton from
 * `@/lib/core/db`; we vi.mock that module and inject the PGlite drizzle
 * client so the real function logic runs against real SQL.
 *
 * Run via: yarn test lib/core/db/agentd.workspaces.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { resetDb, setupPgLiteTestDb } from '@/lib/extra/test/pglite-harness';

// Mirrors lib/core/db/schema/agentd.ts `workspaces` (including the partial
// unique index — the whole point of these tests). If the schema drifts
// from this DDL, the queries below fail, which is the intended signal.
const DDL = [
  `CREATE TABLE "workspaces" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "owner_id" text NOT NULL,
    "name" text NOT NULL,
    "preferred_node_id" text,
    "node_generation" integer DEFAULT 1 NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "visibility" text DEFAULT 'private' NOT NULL,
    "shared_memory_enabled" boolean DEFAULT false NOT NULL,
    "quarantine_epoch" integer DEFAULT 0 NOT NULL,
    "status" text DEFAULT 'active' NOT NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL
  )`,
  `CREATE INDEX "workspaces_owner_idx" ON "workspaces" ("owner_id")`,
  `CREATE UNIQUE INDEX "workspaces_owner_default_uniq"
    ON "workspaces" ("owner_id") WHERE is_default = true`,
  // Minimal users table (mirrors schema/users.ts) — listVisibleWorkspaces
  // joins it for ownerName, resolveWorkspaceAccess/getUserById read it.
  `CREATE TABLE "users" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "username" text NOT NULL,
    "password_hash" text DEFAULT '' NOT NULL,
    "roles" text[] DEFAULT ARRAY['user']::text[] NOT NULL,
    "model_preferences" jsonb,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL
  )`,
  // Minimal sessions table (mirrors schema/chat.ts sessions) — only the
  // columns setWorkspaceVisibilityCascade's resetSharedSessions touches.
  // workspace_id is a soft FK (no ON DELETE CASCADE) to match production.
  `CREATE TABLE "sessions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "workspace_id" uuid,
    "visibility" text DEFAULT 'private' NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL
  )`,
  // Minimal session_memories table (mirrors schema/memory.ts) — only the
  // columns the cascade's quarantineSessionMemories step touches. The
  // subquery joins sessions on workspace_id + visibility='shared'.
  `CREATE TABLE "session_memories" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "session_id" uuid NOT NULL,
    "workspace_id" uuid,
    "content" text NOT NULL,
    "summary_version" integer NOT NULL,
    "is_current" boolean DEFAULT true NOT NULL,
    "quarantined_at" timestamptz,
    "created_at" timestamptz DEFAULT now() NOT NULL
  )`,
  // Minimal long_term_memories table (mirrors schema/memory.ts) — only
  // the columns the cascade's shared-pool quarantine filters / returns on.
  // dream_status + quarantine_meta support the soft-quarantine flip.
  `CREATE TABLE "long_term_memories" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "workspace_id" uuid,
    "shared" boolean DEFAULT false NOT NULL,
    "dream_status" text DEFAULT 'active' NOT NULL,
    "quarantine_meta" jsonb,
    "updated_at" timestamptz DEFAULT now() NOT NULL
  )`,
];

const harness = setupPgLiteTestDb(DDL);

// The factory is hoisted above `harness`'s initializer, so the db binding
// must be exposed via a lazy getter — property access happens inside DAL
// function bodies, i.e. after module evaluation (and after beforeAll has
// applied the DDL).
// Mock `@/lib/core/db` to inject the PGlite drizzle client as `db`, while
// preserving the module's OTHER named exports the DAL reaches via this
// module: `schema` (pure table-definition objects, no connection side
// effects) and `resolveDriver` (used by atomicWriteMode to pick neon-batch
// vs pg-transaction). We CANNOT spread importOriginal() here — importing
// the real module initializes the production neon/pg singleton. `schema`
// is re-exported from `./schema` and is safe to pass through directly; we
// require() it inside the factory so the mock's hoist order is irrelevant.
// Mock `@/lib/core/db` to inject the PGlite drizzle client as `db`, while
// preserving `resolveDriver` (used by atomicWriteMode to pick neon-batch vs
// pg-transaction). We can't spread importOriginal() here — importing the
// real module initializes the production neon/pg singleton. resolveDriver
// is a pure env-based function, so a stub is sufficient and the cascade
// (which only needs `db` + this driver hint) runs against PGlite.
vi.mock('@/lib/core/db', () => ({
  get db() {
    return harness.db;
  },
  resolveDriver: () => 'postgres' as const,
}));

// The cascade's only non-DB side effect is the shared-memory KV version
// bump. PGlite has no kv_store table, and verifying the bump's I/O is
// not this file's goal (long-term.shared-version.test.ts covers that);
// stub it with a spy so we can assert call count / ordering instead.
const bumpSharedMemoryVersionSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/memory/shared-version', () => ({
  bumpSharedMemoryVersion: bumpSharedMemoryVersionSpy,
}));

import {
  archiveWorkspace,
  canAccessWorkspace,
  canManageWorkspace,
  createWorkspace,
  deleteWorkspaceRow,
  getOrCreateDefaultWorkspace,
  getWorkspace,
  listVisibleWorkspaces,
  listWorkspacesByOwner,
  migrateWorkspaceNode,
  renameWorkspace,
  resolveWorkspaceAccess,
  setDefaultWorkspace,
  setWorkspaceSharedMemory,
  setWorkspaceVisibility,
  setWorkspaceVisibilityCascade,
  restoreQuarantinedMemories,
  publicizeWorkspaceCascade,
} from './agentd';

async function seedUser(
  id: string,
  roles: readonly string[] = ['user'],
): Promise<void> {
  // PGlite's wire protocol won't serialize a JS array into a text[]
  // parameter — pass a Postgres array literal instead.
  const rolesLiteral = `{${roles.join(',')}}`;
  await harness.db.execute(
    sql`INSERT INTO "users" ("id", "username", "roles") VALUES (${id}::uuid, ${id}, ${rolesLiteral}::text[])`,
  );
}

// uuid-shaped user ids (users.id is uuid; workspaces.owner_id is text).
const U1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const U2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const BOSS = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const MEMBER = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

/** Concatenate every message + PG `.code` along an error's `.cause` chain.
 *  drizzle-orm wraps driver errors in DrizzleQueryError, so PG details
 *  (23505, constraint names, RAISE messages) sit one or more levels down. */
function errorChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current; depth++) {
    if (typeof current !== 'object') break;
    const code = (current as { code?: unknown }).code;
    parts.push(current instanceof Error ? current.message : String(current));
    if (typeof code === 'string') parts.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join('\n');
}

describe('workspace DAL (PGlite)', () => {
  beforeEach(async () => {
    await resetDb(harness.db, [
      'workspaces',
      'users',
      'sessions',
      'session_memories',
      'long_term_memories',
    ]);
    bumpSharedMemoryVersionSpy.mockClear();
  });

  // Shared seed/count helpers used by both setWorkspaceVisibilityCascade
  // and restoreQuarantinedMemories describe blocks. Hoisted to the parent
  // scope so both can reach them.

  /** Seed a shared-pool long-term memory row for a workspace. */
  async function seedSharedMemory(workspaceId: string): Promise<string> {
    const [row] = (
      await harness.db.execute(
        sql`INSERT INTO "long_term_memories" ("workspace_id", "shared") VALUES (${workspaceId}::uuid, true) RETURNING "id"`,
      )
    ).rows as { id: string }[];
    return row.id;
  }

  /** Seed a shared-visibility session under a workspace. */
  async function seedSharedSession(workspaceId: string): Promise<string> {
    const [row] = (
      await harness.db.execute(
        sql`INSERT INTO "sessions" ("workspace_id", "visibility") VALUES (${workspaceId}::uuid, 'shared') RETURNING "id"`,
      )
    ).rows as { id: string }[];
    return row.id;
  }

  /** Seed a session_memories summary row for a session — the row the
   *  privatization cascade stamps with quarantined_at (while the session
   *  is still shared) and the restore clears. */
  async function seedSessionMemory(sessionId: string): Promise<string> {
    const [row] = (
      await harness.db.execute(
        sql`INSERT INTO "session_memories" ("session_id", "content", "summary_version") VALUES (${sessionId}::uuid, 'summary', 1) RETURNING "id"`,
      )
    ).rows as { id: string }[];
    return row.id;
  }

  /** Read a session_memories row's quarantine stamp back by id. */
  async function getSessionMemory(
    id: string,
  ): Promise<{ quarantined_at: Date | null } | undefined> {
    const rows = (
      await harness.db.execute(
        sql`SELECT "quarantined_at" FROM "session_memories" WHERE "id" = ${id}::uuid`,
      )
    ).rows as { quarantined_at: Date | null }[];
    return rows[0];
  }

  /** Read a session row back by id. */
  async function getSession(
    id: string,
  ): Promise<{ visibility: string } | undefined> {
    const rows = (
      await harness.db.execute(
        sql`SELECT "visibility" FROM "sessions" WHERE "id" = ${id}::uuid`,
      )
    ).rows as { visibility: string }[];
    return rows[0];
  }

  /** Count remaining ACTIVE shared-pool memories for a workspace.
   *  After the soft-quarantine change, privatization flips rows to
   *  dream_status='quarantined' instead of deleting them — so this
   *  helper counts only the rows that are STILL visible to recall
   *  (shared AND active). The raw row count does not change. */
  async function countSharedMemories(workspaceId: string): Promise<number> {
    const rows = (
      await harness.db.execute(
        sql`SELECT count(*)::int AS n FROM "long_term_memories" WHERE "workspace_id" = ${workspaceId}::uuid AND "shared" = true AND "dream_status" = 'active'`,
      )
    ).rows as { n: number }[];
    return rows[0]?.n ?? 0;
  }

  /** Count ALL shared-pool memory rows regardless of dream_status (so a
   *  test can assert that privatization KEPT the rows around in the
   *  'quarantined' state rather than deleting them). */
  async function countAllSharedMemoryRows(
    workspaceId: string,
  ): Promise<number> {
    const rows = (
      await harness.db.execute(
        sql`SELECT count(*)::int AS n FROM "long_term_memories" WHERE "workspace_id" = ${workspaceId}::uuid AND "shared" = true`,
      )
    ).rows as { n: number }[];
    return rows[0]?.n ?? 0;
  }

  describe('renameWorkspace', () => {
    it('renames and trims the name', async () => {
      const ws = await createWorkspace({ ownerId: 'u1', name: 'old' });
      const updated = await renameWorkspace(ws.id, '  new name  ');
      expect(updated?.name).toBe('new name');
      expect((await getWorkspace(ws.id))?.name).toBe('new name');
    });

    it('rejects an empty post-trim name', async () => {
      const ws = await createWorkspace({ ownerId: 'u1', name: 'keep' });
      await expect(renameWorkspace(ws.id, '   ')).rejects.toThrow(
        /must not be empty/,
      );
      expect((await getWorkspace(ws.id))?.name).toBe('keep');
    });

    it('returns null for a missing workspace', async () => {
      const missing = '00000000-0000-0000-0000-000000000000';
      expect(await renameWorkspace(missing, 'x')).toBeNull();
    });
  });

  describe('setDefaultWorkspace', () => {
    it('flags the target and clears the previous default atomically', async () => {
      const first = await getOrCreateDefaultWorkspace('u1');
      expect(first.isDefault).toBe(true);
      const second = await createWorkspace({ ownerId: 'u1', name: 'second' });

      const updated = await setDefaultWorkspace('u1', second.id);
      expect(updated?.isDefault).toBe(true);

      const rows = await listWorkspacesByOwner('u1');
      const defaults = rows.filter((r) => r.isDefault);
      expect(defaults.map((r) => r.id)).toEqual([second.id]);
    });

    it('returns null for another owner’s workspace', async () => {
      const ws = await createWorkspace({ ownerId: 'u1', name: 'mine' });
      expect(await setDefaultWorkspace('u2', ws.id)).toBeNull();
      expect((await getWorkspace(ws.id))?.isDefault).toBe(false);
    });

    it('returns null for an archived workspace', async () => {
      const ws = await createWorkspace({ ownerId: 'u1', name: 'gone' });
      await archiveWorkspace(ws.id);
      expect(await setDefaultWorkspace('u1', ws.id)).toBeNull();
    });

    it('is a no-op when the target is already the default', async () => {
      const ws = await getOrCreateDefaultWorkspace('u1');
      const again = await setDefaultWorkspace('u1', ws.id);
      expect(again?.isDefault).toBe(true);
      const rows = await listWorkspacesByOwner('u1');
      expect(rows.filter((r) => r.isDefault)).toHaveLength(1);
    });

    it('the partial unique index rejects a second live default (23505)', async () => {
      await getOrCreateDefaultWorkspace('u1');
      const error = await harness.db
        .execute(
          sql`INSERT INTO "workspaces" ("owner_id", "name", "is_default") VALUES ('u1', 'dup', true)`,
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeTruthy();
      // drizzle wraps driver errors in DrizzleQueryError — the PG code and
      // constraint name live on the cause chain.
      const text = errorChainText(error);
      expect(text).toContain('23505');
      expect(text).toContain('workspaces_owner_default_uniq');
    });

    it('retries the pair when a concurrent default appears mid-flight', async () => {
      await getOrCreateDefaultWorkspace('u1');
      const second = await createWorkspace({ ownerId: 'u1', name: 'second' });

      // One-shot AFTER UPDATE trigger: right after setDefaultWorkspace's
      // CLEAR commits, insert a "concurrent" default — exactly what a racing
      // getOrCreateDefaultWorkspace would do — so the SET trips the partial
      // unique index. The sequence makes the insert fire exactly once
      // (sequences are non-transactional, so the retry's own UPDATEs don't
      // re-arm it).
      await harness.client.exec(`
        CREATE SEQUENCE concurrent_default_seq;
        CREATE OR REPLACE FUNCTION insert_concurrent_default_once()
          RETURNS trigger AS $fn$
        BEGIN
          IF nextval('concurrent_default_seq') = 1 THEN
            INSERT INTO "workspaces" ("owner_id", "name", "is_default")
              VALUES ('u1', 'concurrent', true);
          END IF;
          RETURN NULL;
        END;
        $fn$ LANGUAGE plpgsql;
        CREATE TRIGGER concurrent_default_trg AFTER UPDATE ON "workspaces"
          FOR EACH STATEMENT EXECUTE FUNCTION insert_concurrent_default_once();
      `);
      try {
        const updated = await setDefaultWorkspace('u1', second.id);
        expect(updated?.id).toBe(second.id);
        expect(updated?.isDefault).toBe(true);

        const rows = await listWorkspacesByOwner('u1');
        const defaults = rows.filter((r) => r.isDefault);
        // The retry cleared the interloper — only the target stays default.
        expect(defaults.map((r) => r.id)).toEqual([second.id]);
        const concurrent = rows.find((r) => r.name === 'concurrent');
        expect(concurrent?.isDefault).toBe(false);
      } finally {
        await harness.client.exec(`
          DROP TRIGGER IF EXISTS concurrent_default_trg ON "workspaces";
          DROP FUNCTION IF EXISTS insert_concurrent_default_once();
          DROP SEQUENCE IF EXISTS concurrent_default_seq;
        `);
      }
    });

    it('restores the previous default when the SET fails with a non-unique error', async () => {
      const first = await getOrCreateDefaultWorkspace('u1');
      const second = await createWorkspace({ ownerId: 'u1', name: 'second' });

      // BEFORE UPDATE trigger limited to rows being SET to is_default=true
      // (the CLEAR sets is_default=false, so WHEN skips it): the first such
      // statement — setDefaultWorkspace's SET — raises a NON-unique error.
      // The sequence (non-transactional) disarms the trigger so the
      // best-effort RESTORE update (also is_default=true) is allowed through.
      await harness.client.exec(`
        CREATE SEQUENCE fail_set_default_seq;
        CREATE OR REPLACE FUNCTION fail_set_default_once()
          RETURNS trigger AS $fn$
        BEGIN
          IF nextval('fail_set_default_seq') = 1 THEN
            RAISE EXCEPTION 'simulated non-unique failure on set-default'
              USING ERRCODE = 'XX000';
          END IF;
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_set_default_trg BEFORE UPDATE ON "workspaces"
          FOR EACH ROW WHEN (NEW.is_default = true)
          EXECUTE FUNCTION fail_set_default_once();
      `);
      try {
        const error = await setDefaultWorkspace('u1', second.id).then(
          () => null,
          (e: unknown) => e,
        );
        expect(error).toBeTruthy();
        // The ORIGINAL (non-unique) error propagated — drizzle wraps it, so
        // match anywhere on the cause chain.
        expect(errorChainText(error)).toContain('simulated non-unique failure');

        // The original error propagated, but the owner was NOT left
        // default-less: the previous default was restored.
        expect((await getWorkspace(first.id))?.isDefault).toBe(true);
        expect((await getWorkspace(second.id))?.isDefault).toBe(false);
        const defaults = (await listWorkspacesByOwner('u1')).filter(
          (r) => r.isDefault,
        );
        expect(defaults.map((r) => r.id)).toEqual([first.id]);
      } finally {
        await harness.client.exec(`
          DROP TRIGGER IF EXISTS fail_set_default_trg ON "workspaces";
          DROP FUNCTION IF EXISTS fail_set_default_once();
          DROP SEQUENCE IF EXISTS fail_set_default_seq;
        `);
      }
    });
  });

  describe('migrateWorkspaceNode', () => {
    it('sets the new node and bumps node_generation', async () => {
      const ws = await createWorkspace({ ownerId: 'u1', name: 'w' });
      const migrated = await migrateWorkspaceNode(ws.id, 'node-a');
      expect(migrated?.preferredNodeId).toBe('node-a');
      expect(migrated?.nodeGeneration).toBe(ws.nodeGeneration + 1);
    });

    it('clears the binding and still bumps generation when no node given', async () => {
      const ws = await createWorkspace({ ownerId: 'u1', name: 'w' });
      await migrateWorkspaceNode(ws.id, 'node-a');
      const cleared = await migrateWorkspaceNode(ws.id);
      expect(cleared?.preferredNodeId).toBeNull();
      expect(cleared?.nodeGeneration).toBe(ws.nodeGeneration + 2);
    });

    it('returns null for an archived workspace', async () => {
      const ws = await createWorkspace({ ownerId: 'u1', name: 'w' });
      await archiveWorkspace(ws.id);
      expect(await migrateWorkspaceNode(ws.id, 'node-a')).toBeNull();
    });
  });

  describe('archiveWorkspace', () => {
    it('drops the default flag so a fresh default can be created', async () => {
      const ws = await getOrCreateDefaultWorkspace('u1');
      const archived = await archiveWorkspace(ws.id);
      expect(archived?.status).toBe('archived');
      expect(archived?.isDefault).toBe(false);

      // The unique index is free again — lazy-create must succeed.
      const fresh = await getOrCreateDefaultWorkspace('u1');
      expect(fresh.id).not.toBe(ws.id);
      expect(fresh.isDefault).toBe(true);
    });
  });

  describe('visibility (public/private)', () => {
    it('setWorkspaceVisibility toggles and refuses archived rows', async () => {
      const ws = await createWorkspace({ ownerId: 'u1', name: 'w' });
      expect(ws.visibility).toBe('private');
      const publicWs = await setWorkspaceVisibility(ws.id, 'public');
      expect(publicWs?.visibility).toBe('public');
      const backPrivate = await setWorkspaceVisibility(ws.id, 'private');
      expect(backPrivate?.visibility).toBe('private');

      await archiveWorkspace(ws.id);
      expect(await setWorkspaceVisibility(ws.id, 'public')).toBeNull();
    });

    it('listVisibleWorkspaces returns own rows plus others’ public ACTIVE ones', async () => {
      await seedUser(U1);
      await seedUser(U2);
      const own = await createWorkspace({ ownerId: U1, name: 'mine' });
      const ownArchived = await createWorkspace({ ownerId: U1, name: 'old' });
      await archiveWorkspace(ownArchived.id);
      const shared = await createWorkspace({ ownerId: U2, name: 'shared' });
      await setWorkspaceVisibility(shared.id, 'public');
      const hidden = await createWorkspace({ ownerId: U2, name: 'hidden' });
      const archivedShared = await createWorkspace({
        ownerId: U2,
        name: 'gone',
      });
      await setWorkspaceVisibility(archivedShared.id, 'public');
      await archiveWorkspace(archivedShared.id);

      const visible = await listVisibleWorkspaces(U1);
      const ids = visible.map((w) => w.id);
      expect(ids).toContain(own.id);
      expect(ids).toContain(ownArchived.id); // own archived stays manageable
      expect(ids).toContain(shared.id);
      expect(ids).not.toContain(hidden.id); // others' private is invisible
      expect(ids).not.toContain(archivedShared.id); // archived never shared
      expect(visible.find((w) => w.id === shared.id)?.ownerName).toBe(U2);
      expect(visible.find((w) => w.id === own.id)?.ownerName).toBeUndefined();
    });

    it('canManageWorkspace encodes the owner/admin/protected hierarchy', () => {
      const ws = { ownerId: 'u1' };
      const user = { userId: 'u1', roles: ['user'] };
      const otherUser = { userId: 'u9', roles: ['user'] };
      const admin = { userId: 'u9', roles: ['admin'] };
      // owner always manages
      expect(canManageWorkspace(ws, user, ['user'])).toBe(true);
      // plain member cannot
      expect(canManageWorkspace(ws, otherUser, ['user'])).toBe(false);
      // admin manages ordinary users' workspaces…
      expect(canManageWorkspace(ws, admin, ['user'])).toBe(true);
      // …but never an owner/root's
      expect(canManageWorkspace(ws, admin, ['owner'])).toBe(false);
      expect(canManageWorkspace(ws, admin, ['root'])).toBe(false);
    });

    it('canAccessWorkspace opens public workspaces to everyone', () => {
      const member = { userId: 'u9', roles: ['user'] };
      expect(
        canAccessWorkspace({ ownerId: 'u1', visibility: 'public' }, member, [
          'user',
        ]),
      ).toBe(true);
      expect(
        canAccessWorkspace({ ownerId: 'u1', visibility: 'private' }, member, [
          'user',
        ]),
      ).toBe(false);
    });

    it('resolveWorkspaceAccess combines row + owner roles', async () => {
      await seedUser(U1);
      await seedUser(BOSS, ['owner']);
      const mine = await createWorkspace({ ownerId: U1, name: 'mine' });
      const bossWs = await createWorkspace({ ownerId: BOSS, name: 'boss' });

      const member = { userId: MEMBER, roles: ['user'] };
      const admin = { userId: MEMBER, roles: ['admin'] };

      // member: no access to a private workspace
      const denied = await resolveWorkspaceAccess(mine.id, member);
      expect(denied?.canAccess).toBe(false);
      expect(denied?.canManage).toBe(false);

      // admin: manages U1's workspace, but not the owner-role user's
      const adminOnMine = await resolveWorkspaceAccess(mine.id, admin);
      expect(adminOnMine?.canAccess).toBe(true);
      expect(adminOnMine?.canManage).toBe(true);
      const adminOnBoss = await resolveWorkspaceAccess(bossWs.id, admin);
      expect(adminOnBoss?.canAccess).toBe(false);
      expect(adminOnBoss?.canManage).toBe(false);

      // public opens access but NOT manage
      await setWorkspaceVisibility(mine.id, 'public');
      const memberOnPublic = await resolveWorkspaceAccess(mine.id, member);
      expect(memberOnPublic?.canAccess).toBe(true);
      expect(memberOnPublic?.canManage).toBe(false);

      expect(
        await resolveWorkspaceAccess(
          '00000000-0000-0000-0000-000000000000',
          admin,
        ),
      ).toBeNull();
    });

    it('listVisibleWorkspaces skips non-UUID owners instead of throwing (22P02)', async () => {
      await seedUser(U1);
      await seedUser(U2);
      const own = await createWorkspace({ ownerId: U1, name: 'mine' });
      const shared = await createWorkspace({ ownerId: U2, name: 'shared' });
      await setWorkspaceVisibility(shared.id, 'public');
      // owner_id is free-text: a 'system'-owned public ACTIVE workspace
      // must not crash the users join (owner_id::uuid on a non-UUID
      // string throws PG 22P02) — it is filtered out of the shared
      // surface entirely.
      const systemOwned = await createWorkspace({
        ownerId: 'system',
        name: 'sys',
      });
      await setWorkspaceVisibility(systemOwned.id, 'public');

      const visible = await listVisibleWorkspaces(U1);
      const ids = visible.map((w) => w.id);
      expect(ids).toContain(own.id);
      expect(ids).toContain(shared.id);
      expect(ids).not.toContain(systemOwned.id);

      // The same row must also resolve without throwing: the non-UUID
      // owner is treated as ownerless (no users-row lookup), so the
      // public workspace is accessible but unmanageable.
      const access = await resolveWorkspaceAccess(systemOwned.id, {
        userId: U1,
        roles: ['user'],
      });
      expect(access).not.toBeNull();
      expect(access?.canAccess).toBe(true);
      expect(access?.canManage).toBe(false);
    });

    it('setWorkspaceSharedMemory toggles and refuses archived rows', async () => {
      const ws = await createWorkspace({ ownerId: 'u1', name: 'w' });
      expect(ws.sharedMemoryEnabled).toBe(false);
      const enabled = await setWorkspaceSharedMemory(ws.id, true);
      expect(enabled?.sharedMemoryEnabled).toBe(true);
      const disabled = await setWorkspaceSharedMemory(ws.id, false);
      expect(disabled?.sharedMemoryEnabled).toBe(false);

      await archiveWorkspace(ws.id);
      expect(await setWorkspaceSharedMemory(ws.id, true)).toBeNull();
    });
  });

  describe('setWorkspaceVisibilityCascade', () => {
    it('private→public only moves the visibility column', async () => {
      const ws = await createWorkspace({ ownerId: 'u1', name: 'w' });
      // Start from public with shared pool + shared sessions so we can
      // prove the public direction does NOT touch them.
      await setWorkspaceVisibility(ws.id, 'public');
      await setWorkspaceSharedMemory(ws.id, true);
      await seedSharedMemory(ws.id);
      const sessId = await seedSharedSession(ws.id);

      const result = await setWorkspaceVisibilityCascade(ws.id, 'public');
      expect(result?.visibility).toBe('public');
      // Re-publishing is a no-op on dependents.
      expect(await countSharedMemories(ws.id)).toBe(1);
      expect((await getSession(sessId))?.visibility).toBe('shared');
      // No shared pool was dropped, so the KV bump is NOT issued for
      // the public direction (no DB delete occurred).
      expect(bumpSharedMemoryVersionSpy).not.toHaveBeenCalled();
    });

    it('public→private soft-quarantines shared pool (rows kept, flipped to quarantined) — pg branch', async () => {
      const ws = await createWorkspace({ ownerId: 'u1', name: 'w' });
      await setWorkspaceVisibility(ws.id, 'public');
      await setWorkspaceSharedMemory(ws.id, true);
      const memId = await seedSharedMemory(ws.id);
      const sessId = await seedSharedSession(ws.id);
      bumpSharedMemoryVersionSpy.mockClear();

      const result = await setWorkspaceVisibilityCascade(ws.id, 'private');

      // Step 1: visibility flipped.
      expect(result?.visibility).toBe('private');
      // Step 2: shared pool soft-quarantined — ACTIVE shared count drops
      // to 0 (recall no longer sees them) but the rows physically survive
      // in dream_status='quarantined' for later restoration.
      expect(await countSharedMemories(ws.id)).toBe(0);
      expect(await countAllSharedMemoryRows(ws.id)).toBe(1);
      const qRow = (
        await harness.db.execute(
          sql`SELECT "dream_status", "quarantine_meta" FROM "long_term_memories" WHERE "id" = ${memId}::uuid`,
        )
      ).rows as { dream_status: string; quarantine_meta: unknown }[];
      expect(qRow[0]?.dream_status).toBe('quarantined');
      expect(qRow[0]?.quarantine_meta).toMatchObject({
        workspaceId: ws.id,
        originalDreamStatus: 'active',
      });
      // Step 3: shared sessions reset to private.
      expect((await getSession(sessId))?.visibility).toBe('private');
      // Step 4: shared-memory toggle forced off, AND reflected in the
      // returned row (no stale sharedMemoryEnabled:true).
      expect(result?.sharedMemoryEnabled).toBe(false);
      const fresh = await getWorkspace(ws.id);
      expect(fresh?.sharedMemoryEnabled).toBe(false);
      // KV bump ran exactly once, AFTER the DB block.
      expect(bumpSharedMemoryVersionSpy).toHaveBeenCalledTimes(1);
      expect(bumpSharedMemoryVersionSpy).toHaveBeenCalledWith(ws.id);
    });

    it('returns null for archived rows without touching dependents', async () => {
      const ws = await createWorkspace({ ownerId: 'u1', name: 'w' });
      await setWorkspaceVisibility(ws.id, 'public');
      await setWorkspaceSharedMemory(ws.id, true);
      await seedSharedMemory(ws.id);
      const sessId = await seedSharedSession(ws.id);
      await archiveWorkspace(ws.id);
      bumpSharedMemoryVersionSpy.mockClear();

      const result = await setWorkspaceVisibilityCascade(ws.id, 'private');

      expect(result).toBeNull();
      // Archived row is immutable: dependents survive untouched.
      expect(await countSharedMemories(ws.id)).toBe(1);
      expect((await getSession(sessId))?.visibility).toBe('shared');
      expect(bumpSharedMemoryVersionSpy).not.toHaveBeenCalled();
    });

    it('ignores a concurrent archive that lands between pre-flight and tx writes', async () => {
      // Regression for the TOCTOU window opened by the non-interactive
      // batch / pre-flight check: the pre-flight SELECT reads
      // status='active' and returns the row, then a concurrent request
      // archives the workspace before the UPDATE statements run. With the
      // status='active' guard in each workspaces UPDATE's WHERE clause,
      // the visibility / shared-memory-toggle writes become 0-row no-ops
      // on the now-archived row — its core fields are not dirty-written.
      // The dependent cascade writes (shared sessions reset, shared-pool
      // delete) are gated on the SAME active check via an inline
      // `EXISTS (... workspaces.status='active')`, so they ALSO become
      // 0-row no-ops on an archived workspace, and the KV version bump is
      // suppressed because the delete returned zero rows. This test pins
      // every guarantee the guard provides: the workspaces row, the
      // dependent rows, and the bump call count.
      const ws = await createWorkspace({ ownerId: 'u1', name: 'w' });
      await setWorkspaceVisibility(ws.id, 'public');
      await setWorkspaceSharedMemory(ws.id, true);
      const sessId = await seedSharedSession(ws.id);
      await seedSharedMemory(ws.id);
      bumpSharedMemoryVersionSpy.mockClear();

      // Wrap the real transaction primitive so the concurrent archive
      // lands AFTER the cascade's pre-flight (which already returned the
      // active row) but BEFORE the first UPDATE inside the tx callback.
      // `harness.db` is the same drizzle client the DAL uses (injected via
      // the mock getter), so archiving through it is visible to the tx.
      const realTransaction = harness.db.transaction.bind(harness.db);
      // `vi.spyOn` locks in drizzle's full generics for the transaction
      // callback; cast the mock body through unknown so we don't have to
      // repeat PgTransaction<...> parameter types verbatim.
      const txSpy = vi
        .spyOn(harness.db, 'transaction')
        .mockImplementation((async (cb: (tx: unknown) => Promise<unknown>) => {
          // Simulate the racing archive: flips status to 'archived'
          // mid-flight, exactly as a concurrent request would.
          await archiveWorkspace(ws.id);
          return realTransaction(cb as never);
        }) as never);

      try {
        const result = await setWorkspaceVisibilityCascade(ws.id, 'private');
        // The post-cascade re-read finds the archived row. With the guard
        // the two workspaces UPDATEs were 0-row no-ops, so the row's
        // visibility, shared-memory toggle and status are unchanged from
        // their pre-archive values. Without the guard the archived row
        // would have been silently flipped to private + toggle off.
        expect(result?.visibility).toBe('public');
        expect(result?.sharedMemoryEnabled).toBe(true);
        expect(result?.status).toBe('archived');
        // The dependent writes were also 0-row no-ops: the shared session
        // stayed shared and the shared-memory pool row survived (still
        // active, NOT quarantined). Without the EXISTS guard these would
        // have been reset to 'private' / quarantined respectively, even
        // though the workspace was already archived — the dependent
        // writes' own WHERE clauses only filter on
        // (workspace_id, shared/visibility), never on the workspace's
        // status.
        expect((await getSession(sessId))?.visibility).toBe('shared');
        expect(await countSharedMemories(ws.id)).toBe(1);
        // The shared-pool quarantine was a 0-row no-op, so the post-commit
        // KV version bump must NOT fire.
        expect(bumpSharedMemoryVersionSpy).not.toHaveBeenCalled();
      } finally {
        txSpy.mockRestore();
      }
    });
  });

  describe('restoreQuarantinedMemories', () => {
    it('restores quarantined shared-pool rows to originalDreamStatus and clears session_memories (private→public→private→public cycle)', async () => {
      const ws = await createWorkspace({ ownerId: 'u1', name: 'w' });
      await setWorkspaceVisibility(ws.id, 'public');
      await setWorkspaceSharedMemory(ws.id, true);
      const memId = await seedSharedMemory(ws.id);
      const sessId = await seedSharedSession(ws.id);
      const sessMemId = await seedSessionMemory(sessId);

      // Privatize: soft-quarantine the shared pool.
      await setWorkspaceVisibilityCascade(ws.id, 'private');
      expect(await countSharedMemories(ws.id)).toBe(0);
      expect(await countAllSharedMemoryRows(ws.id)).toBe(1);
      // The session's summary row was stamped while the session was still
      // shared (the cascade stamps session_memories BEFORE resetting
      // sessions.visibility — the subquery filters on visibility='shared').
      expect(
        (await getSessionMemory(sessMemId))?.quarantined_at,
      ).not.toBeNull();

      // Re-public: restore flips the quarantined row back to active.
      bumpSharedMemoryVersionSpy.mockClear();
      const restore1 = await restoreQuarantinedMemories(ws.id, 'run-1');
      expect(restore1.workspace?.visibility).toBe('private'); // restore doesn't flip visibility
      expect(restore1.restoredMemoryCount).toBe(1);
      // Exactly the one seeded session_memories row was un-stamped.
      expect(restore1.restoredSessionMemoryCount).toBe(1);
      expect((await getSessionMemory(sessMemId))?.quarantined_at).toBeNull();
      expect(await countSharedMemories(ws.id)).toBe(1);
      // The restored row's quarantine_meta carries restoredByRunId (audit).
      const r1 = (
        await harness.db.execute(
          sql`SELECT "dream_status", "quarantine_meta" FROM "long_term_memories" WHERE "id" = ${memId}::uuid`,
        )
      ).rows as { dream_status: string; quarantine_meta: unknown }[];
      expect(r1[0]?.dream_status).toBe('active');
      expect(r1[0]?.quarantine_meta).toMatchObject({
        restoredByRunId: 'run-1',
        originalDreamStatus: 'active',
      });
      expect(bumpSharedMemoryVersionSpy).toHaveBeenCalledTimes(1);

      // Cycle again: privatize re-quarantines the (now-restored) active
      // row. Because the privatization cascade only touches rows where
      // dream_status='active', and the restored row IS active again, it
      // gets re-quarantined. The WHERE on restoredByRunId in the restore
      // is about the CURRENT quarantine_meta, not historical — a fresh
      // privatization overwrites quarantine_meta with a new object lacking
      // restoredByRunId, so the row is eligible for restore again.
      await setWorkspaceVisibilityCascade(ws.id, 'private');
      expect(await countSharedMemories(ws.id)).toBe(0);
      const restore2 = await restoreQuarantinedMemories(ws.id, 'run-2');
      expect(restore2.restoredMemoryCount).toBe(1);
      expect(await countSharedMemories(ws.id)).toBe(1);
      const r2 = (
        await harness.db.execute(
          sql`SELECT "quarantine_meta" FROM "long_term_memories" WHERE "id" = ${memId}::uuid`,
        )
      ).rows as { quarantine_meta: unknown }[];
      expect(r2[0]?.quarantine_meta).toMatchObject({
        restoredByRunId: 'run-2',
      });
      // Session visibility was reset to private by the second privatize;
      // restore doesn't touch session visibility (only the cascade does).
      expect((await getSession(sessId))?.visibility).toBe('private');
    });

    it('returns zero counts for archived/missing workspace without touching rows', async () => {
      const ws = await createWorkspace({ ownerId: 'u1', name: 'w' });
      await setWorkspaceVisibility(ws.id, 'public');
      await setWorkspaceSharedMemory(ws.id, true);
      await seedSharedMemory(ws.id);
      await setWorkspaceVisibilityCascade(ws.id, 'private');
      await archiveWorkspace(ws.id);
      bumpSharedMemoryVersionSpy.mockClear();

      const restore = await restoreQuarantinedMemories(ws.id);
      expect(restore.workspace).toBeNull();
      expect(restore.restoredMemoryCount).toBe(0);
      expect(bumpSharedMemoryVersionSpy).not.toHaveBeenCalled();
      // Rows survive, still quarantined.
      expect(await countAllSharedMemoryRows(ws.id)).toBe(1);
      expect(await countSharedMemories(ws.id)).toBe(0);
    });

    it('does not re-restore rows already consumed by a previous restore in the same isolation epoch', async () => {
      // Scenario: privatize isolates a row. Restore-1 consumes it
      // (restoredByRunId set). WITHOUT going private again, a second
      // restore call must skip it — restoredByRunId IS NOT NULL. This is
      // the "keep all history, never duplicate" guard for repeated
      // public→public no-ops.
      const ws = await createWorkspace({ ownerId: 'u1', name: 'w' });
      await setWorkspaceVisibility(ws.id, 'public');
      await setWorkspaceSharedMemory(ws.id, true);
      await seedSharedMemory(ws.id);
      await setWorkspaceVisibilityCascade(ws.id, 'private');

      const r1 = await restoreQuarantinedMemories(ws.id, 'run-1');
      expect(r1.restoredMemoryCount).toBe(1);
      const r2 = await restoreQuarantinedMemories(ws.id, 'run-2');
      expect(r2.restoredMemoryCount).toBe(0); // already consumed
      expect(await countSharedMemories(ws.id)).toBe(1);
    });
  });

  describe('publicizeWorkspaceCascade', () => {
    it('flips visibility to public AND restores quarantined rows atomically', async () => {
      const ws = await createWorkspace({ ownerId: 'u1', name: 'w' });
      await setWorkspaceVisibility(ws.id, 'public');
      await setWorkspaceSharedMemory(ws.id, true);
      const memId = await seedSharedMemory(ws.id);
      const sessId = await seedSharedSession(ws.id);
      const sessMemId = await seedSessionMemory(sessId);
      await setWorkspaceVisibilityCascade(ws.id, 'private');
      expect(await countSharedMemories(ws.id)).toBe(0);
      expect(
        (await getSessionMemory(sessMemId))?.quarantined_at,
      ).not.toBeNull();
      bumpSharedMemoryVersionSpy.mockClear();

      const result = await publicizeWorkspaceCascade(ws.id, 'run-pub');

      // One atomic block: visibility is public AND the pool is restored.
      expect(result.workspace?.visibility).toBe('public');
      expect(result.restoredMemoryCount).toBe(1);
      expect(result.restoredSessionMemoryCount).toBe(1);
      expect(await countSharedMemories(ws.id)).toBe(1);
      expect((await getSessionMemory(sessMemId))?.quarantined_at).toBeNull();
      const row = (
        await harness.db.execute(
          sql`SELECT "dream_status", "quarantine_meta" FROM "long_term_memories" WHERE "id" = ${memId}::uuid`,
        )
      ).rows as { dream_status: string; quarantine_meta: unknown }[];
      expect(row[0]?.dream_status).toBe('active');
      expect(row[0]?.quarantine_meta).toMatchObject({
        restoredByRunId: 'run-pub',
      });
      expect(bumpSharedMemoryVersionSpy).toHaveBeenCalledTimes(1);
      expect(bumpSharedMemoryVersionSpy).toHaveBeenCalledWith(ws.id);
    });

    it('returns null workspace and zero counts for an archived workspace', async () => {
      const ws = await createWorkspace({ ownerId: 'u1', name: 'w' });
      await setWorkspaceVisibility(ws.id, 'public');
      await setWorkspaceSharedMemory(ws.id, true);
      await seedSharedMemory(ws.id);
      await setWorkspaceVisibilityCascade(ws.id, 'private');
      await archiveWorkspace(ws.id);
      bumpSharedMemoryVersionSpy.mockClear();

      const result = await publicizeWorkspaceCascade(ws.id);
      expect(result.workspace).toBeNull();
      expect(result.restoredMemoryCount).toBe(0);
      expect(result.restoredSessionMemoryCount).toBe(0);
      expect(bumpSharedMemoryVersionSpy).not.toHaveBeenCalled();
      expect((await getWorkspace(ws.id))?.visibility).toBe('private');
      expect(await countSharedMemories(ws.id)).toBe(0);
      expect(await countAllSharedMemoryRows(ws.id)).toBe(1);
    });
  });

  describe('deleteWorkspaceRow', () => {
    it('deleteWorkspaceRow removes the row and frees the default slot', async () => {
      const ws = await getOrCreateDefaultWorkspace('u1');
      const deleted = await deleteWorkspaceRow(ws.id);
      expect(deleted?.id).toBe(ws.id);
      expect(await getWorkspace(ws.id)).toBeNull();
      // The unique index is free again — lazy-create must succeed.
      const fresh = await getOrCreateDefaultWorkspace('u1');
      expect(fresh.id).not.toBe(ws.id);
      expect(fresh.isDefault).toBe(true);
    });
  });
});
