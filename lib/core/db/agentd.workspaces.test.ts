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
];

const harness = setupPgLiteTestDb(DDL);

// The factory is hoisted above `harness`'s initializer, so the db binding
// must be exposed via a lazy getter — property access happens inside DAL
// function bodies, i.e. after module evaluation (and after beforeAll has
// applied the DDL).
vi.mock('@/lib/core/db', () => ({
  get db() {
    return harness.db;
  },
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

describe('workspace DAL (PGlite)', () => {
  beforeEach(async () => {
    await resetDb(harness.db, ['workspaces', 'users']);
  });

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
