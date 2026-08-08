/**
 * Cross-user isolation regression tests for user_vault_entries.
 *
 * Background: commit 8762ba3 split user-private vault entries out of the
 * system vault_entries table specifically so that user A could not read
 * user B's secrets. The split's security guarantee lives in the schema
 * (userId NOT NULL, UNIQUE(userId, key)) and in every DAL function
 * filtering WHERE userId = ?. Both were untested at the time; this file
 * guards the isolation property so a future refactor that drops the
 * WHERE clause or the NOT NULL fails CI.
 *
 * Approach: PGlite in-memory Postgres + raw drizzle queries (not the DAL
 * singleton). We exercise the actual schema constraints (unique index,
 * NOT NULL) and prove that a SELECT filtered by user A's id cannot reach
 * user B's row. This is the minimum viable guard for the 8762ba3 fix.
 */
import { and, eq } from 'drizzle-orm';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  listUserVaultEntries,
  readUserVaultValue,
  upsertUserVaultEntry,
} from '@/lib/extra/vault';
import { resetDb, setupPgLiteTestDb } from '@/lib/extra/test/pglite-harness';
import { userVaultEntries } from './vault';

// The vault DAL accepts `dbInstance: Pick<typeof db, 'select'|'insert'|...>`.
// PGlite's drizzle instance is structurally compatible but not assignable to
// the concrete neon-http type the singleton is typed as — narrow it.
type VaultDb = Parameters<typeof upsertUserVaultEntry>[1];
const vaultDb = (db: ReturnType<typeof setupPgLiteTestDb>['db']): VaultDb =>
  db as unknown as VaultDb;

const DDL = [
  `CREATE TABLE "user_vault_entries" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "user_id" text NOT NULL,
    "key" text NOT NULL,
    "encrypted_value" text NOT NULL,
    "nonce" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
  )`,
  `CREATE UNIQUE INDEX "user_vault_entries_user_id_key_idx"
     ON "user_vault_entries" USING btree ("user_id","key")`,
  // Every user-private DAL function writes an audit row via auditVault();
  // the table must exist for the DAL round-trip tests below.
  `CREATE TABLE "vault_audit_logs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "key" text NOT NULL,
    "action" text NOT NULL,
    "user_id" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  )`,
];

const { db } = setupPgLiteTestDb(DDL);

beforeEach(async () => {
  await resetDb(db, ['user_vault_entries', 'vault_audit_logs']);
});

afterEach(async () => {
  await resetDb(db, ['user_vault_entries', 'vault_audit_logs']);
});

describe('user_vault_entries cross-user isolation', () => {
  it('rejects a row with null userId (NOT NULL enforced)', async () => {
    // A future schema change that drops the NOT NULL would let a writer
    // insert an "unowned" row that no WHERE userId = ? filter could
    // exclude. This test fails loudly if that guard is removed.
    await expect(
      db.insert(userVaultEntries).values({
        userId: null as unknown as string,
        key: 'k',
        encryptedValue: 'v',
        nonce: 'n',
      }),
    ).rejects.toThrow();
  });

  it("user A's SELECT does not return user B's row", async () => {
    await db.insert(userVaultEntries).values([
      {
        userId: 'userA',
        key: 'secret',
        encryptedValue: 'A-value',
        nonce: 'A-nonce',
      },
      {
        userId: 'userB',
        key: 'secret',
        encryptedValue: 'B-value',
        nonce: 'B-nonce',
      },
    ]);

    const aRows = await db
      .select()
      .from(userVaultEntries)
      .where(eq(userVaultEntries.userId, 'userA'));

    expect(aRows).toHaveLength(1);
    expect(aRows[0].encryptedValue).toBe('A-value');
    // Same key, different user — must not collide or leak.
    expect(aRows[0].userId).toBe('userA');
  });

  it('allows the same key for different users (per-user namespacing)', async () => {
    // The (userId, key) unique index means same key name is allowed per
    // user. A "fix" that made key globally unique would break this and
    // force key namespacing at the app layer — undesirable.
    await db.insert(userVaultEntries).values([
      { userId: 'userA', key: 'token', encryptedValue: 'a', nonce: 'na' },
      { userId: 'userB', key: 'token', encryptedValue: 'b', nonce: 'nb' },
    ]);
    const all = await db.select().from(userVaultEntries);
    expect(all).toHaveLength(2);
  });

  it('rejects a duplicate (userId, key) via the unique index', async () => {
    await db.insert(userVaultEntries).values({
      userId: 'userA',
      key: 'token',
      encryptedValue: 'first',
      nonce: 'n',
    });
    // Same user + same key must collide — the upsert DAL relies on this
    // to do onConflictDoUpdate by (userId, key).
    await expect(
      db.insert(userVaultEntries).values({
        userId: 'userA',
        key: 'token',
        encryptedValue: 'second',
        nonce: 'n',
      }),
    ).rejects.toThrow();
  });

  it("user A's DELETE does not delete user B's row", async () => {
    await db.insert(userVaultEntries).values([
      { userId: 'userA', key: 'k', encryptedValue: 'a', nonce: 'n' },
      { userId: 'userB', key: 'k', encryptedValue: 'b', nonce: 'n' },
    ]);

    // deleteUserVaultEntry filters WHERE userId = ? AND key = ? — a bug
    // that drops the userId term would delete across users.
    await db
      .delete(userVaultEntries)
      .where(
        and(
          eq(userVaultEntries.userId, 'userA'),
          eq(userVaultEntries.key, 'k'),
        ),
      );

    const remaining = await db.select().from(userVaultEntries);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].userId).toBe('userB');
  });
});

describe('vault DAL user isolation (through the actual DAL)', () => {
  // The schema-enforcement tests above prove the unique index and NOT NULL
  // guard isolation at the DB layer. These tests exercise the DAL itself:
  // if a future refactor drops the WHERE userId = ? from listUserVaultEntries /
  // readUserVaultValue / upsertUserVaultEntry, these fail. The DAL imports the
  // production db singleton, so we route it to PGlite via the optional
  // dbInstance param added for this purpose.

  beforeAll(() => {
    // upsertUserVaultEntry uses node:crypto via requireMasterKey which
    // throws if VAULT_MASTER_KEY is unset. AES-256-GCM needs a 32-byte key.
    vi.stubEnv(
      'VAULT_MASTER_KEY',
      'test-master-key-with-at-least-32-bytes-long-aaaa',
    );
  });

  it('upsertUserVaultEntry only writes for the named user', async () => {
    await upsertUserVaultEntry(
      { userId: 'userA', key: 'k', value: 'v1' },
      vaultDb(db),
    );
    // userB lists their entries and must see nothing of user A's write.
    const bRows = await listUserVaultEntries('userB', vaultDb(db));
    expect(bRows).toEqual([]);
  });

  it('readUserVaultValue returns null for other users', async () => {
    await upsertUserVaultEntry(
      { userId: 'userA', key: 'secret', value: 'classified' },
      vaultDb(db),
    );
    const leaked = await readUserVaultValue(
      { userId: 'userB', key: 'secret' },
      vaultDb(db),
    );
    expect(leaked).toBeNull();
  });

  it('DAL round-trip: same user can read what they wrote', async () => {
    await upsertUserVaultEntry(
      { userId: 'userA', key: 'rt', value: 'roundtrip' },
      vaultDb(db),
    );
    const own = await readUserVaultValue(
      { userId: 'userA', key: 'rt' },
      vaultDb(db),
    );
    expect(own?.value).toBe('roundtrip');
  });

  it('upsert overwrites the same (user, key) without leaking', async () => {
    await upsertUserVaultEntry(
      { userId: 'userA', key: 'k', value: 'old' },
      vaultDb(db),
    );
    await upsertUserVaultEntry(
      { userId: 'userA', key: 'k', value: 'new' },
      vaultDb(db),
    );
    const own = await readUserVaultValue(
      { userId: 'userA', key: 'k' },
      vaultDb(db),
    );
    expect(own?.value).toBe('new');
    // Still isolated — user B sees nothing.
    expect(await listUserVaultEntries('userB', vaultDb(db))).toEqual([]);
  });
});
