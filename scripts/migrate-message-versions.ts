/**
 * One-shot data migration: convert legacy `metadata.editHistory` /
 * `metadata.generationHistory` fields on messages.payload into the
 * unified `metadata.versions` + `currentVersionIndex` model.
 *
 * Run by postbuild after `drizzle-kit push`. Idempotent — messages
 * already in the new format are skipped.
 *
 * Mapping:
 *   user message:      editHistory[i]            → versions[i]
 *                      editHistory[i].responseParts → versions[i].response
 *                      currentEditIndex          → currentVersionIndex
 *   assistant message: generationHistory[i]      → versions[i]
 *                      currentGenerationIndex    → currentVersionIndex
 */
import { neon } from '@neondatabase/serverless';

type LegacyEntry = {
  parts?: Array<Record<string, unknown>>;
  responseParts?: Array<Record<string, unknown>>;
  createdAt?: string;
};

type LegacyMetadata = {
  editHistory?: LegacyEntry[];
  currentEditIndex?: number;
  generationHistory?: LegacyEntry[];
  currentGenerationIndex?: number;
  versions?: unknown;
};

type Row = {
  id: string;
  payload: Record<string, unknown>;
};

function coerceParts(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function migrateMetadata(metadata: LegacyMetadata): Record<string, unknown> | null {
  // Already migrated — leave untouched.
  if (Array.isArray(metadata.versions)) return null;

  const versions: Array<{
    parts: unknown[];
    createdAt: string;
    response?: unknown[];
  }> = [];

  // User message path: editHistory → versions (preserving responseParts as response).
  if (Array.isArray(metadata.editHistory)) {
    for (const entry of metadata.editHistory) {
      const parts = coerceParts(entry?.parts);
      const createdAt = typeof entry?.createdAt === 'string' ? entry.createdAt! : new Date().toISOString();
      const version: { parts: unknown[]; createdAt: string; response?: unknown[] } = { parts, createdAt };
      // Preserve paired assistant reply snapshot — critical for edit/rewind semantics.
      if (Array.isArray(entry?.responseParts)) {
        version.response = entry.responseParts;
      }
      versions.push(version);
    }
    const currentVersionIndex =
      typeof metadata.currentEditIndex === 'number' ? metadata.currentEditIndex : 0;
    return { versions, currentVersionIndex };
  }

  // Assistant message path: generationHistory → versions (no response field).
  if (Array.isArray(metadata.generationHistory)) {
    for (const entry of metadata.generationHistory) {
      const parts = coerceParts(entry?.parts);
      const createdAt = typeof entry?.createdAt === 'string' ? entry.createdAt! : new Date().toISOString();
      versions.push({ parts, createdAt });
    }
    const currentVersionIndex =
      typeof metadata.currentGenerationIndex === 'number'
        ? metadata.currentGenerationIndex
        : 0;
    return { versions, currentVersionIndex };
  }

  return null;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('[migrate-versions] DATABASE_URL is required');
  }
  const sql = neon(databaseUrl);

  // Pull candidate rows in batches. We filter on the jsonb path to only
  // touch rows that still carry a legacy field, so re-runs are cheap.
  const BATCH = 200;
  let offset = 0;
  let migrated = 0;
  let scanned = 0;

  while (true) {
    const rows = (await sql.query(
      `SELECT id, payload
       FROM messages
       WHERE payload->'metadata' ?| ARRAY['editHistory','generationHistory']
       ORDER BY id
       LIMIT $1 OFFSET $2`,
      [BATCH, offset],
    )) as Row[];

    if (rows.length === 0) break;
    scanned += rows.length;

    for (const row of rows) {
      const payload = row.payload ?? {};
      const metadata = (payload.metadata ?? {}) as LegacyMetadata;
      const migratedMetadata = migrateMetadata(metadata);
      if (!migratedMetadata) continue;

      // Preserve any non-versioning metadata keys (stepNumber, createdAt, …).
      const newMetadata = { ...metadata, ...migratedMetadata };
      // Drop the legacy keys so subsequent runs skip this row.
      delete (newMetadata as Record<string, unknown>).editHistory;
      delete (newMetadata as Record<string, unknown>).currentEditIndex;
      delete (newMetadata as Record<string, unknown>).generationHistory;
      delete (newMetadata as Record<string, unknown>).currentGenerationIndex;

      const updatedPayload = { ...payload, metadata: newMetadata };
      await sql.query(
        `UPDATE messages SET payload = $1 WHERE id = $2`,
        [JSON.stringify(updatedPayload), row.id],
      );
      migrated += 1;
    }

    offset += rows.length;
    if (rows.length < BATCH) break;
  }

  console.log(
    `[migrate-versions] scanned=${scanned} migrated=${migrated} (idempotent; re-runs skip already-migrated rows)`,
  );
}

main().catch((error) => {
  console.error('[migrate-versions] failed:', error);
  process.exit(1);
});
