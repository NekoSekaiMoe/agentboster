import { db, schema } from '@/lib/core/db';
import { and, asc, desc, eq, gt, lt } from 'drizzle-orm';

type FileRecordMetadata = Record<string, unknown> | null | undefined;

export async function createFileRecord(input: {
  sessionId: string;
  runId?: string | null;
  sandboxId?: string | null;
  sourcePath: string;
  fileName: string;
  mimeType: string;
  size: number;
  blobPath: string;
  blobUrl: string;
  metadata?: FileRecordMetadata;
}) {
  const [record] = await db
    .insert(schema.files)
    .values({
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      sandboxId: input.sandboxId ?? null,
      sourcePath: input.sourcePath,
      fileName: input.fileName,
      mimeType: input.mimeType,
      size: input.size,
      blobPath: input.blobPath,
      blobUrl: input.blobUrl,
      metadata: input.metadata ?? null,
    })
    .returning();

  if (!record) {
    throw new Error('Failed to create file record.');
  }

  return record;
}

export type ListFilesOptions = {
  sessionId?: string;
  userId?: string;
  limit?: number;
  before?: Date;
  sort?: 'asc' | 'desc';
};

export type ListedFileRecord = {
  id: string;
  sessionId: string;
  runId: string | null;
  sandboxId: string | null;
  sourcePath: string;
  fileName: string;
  mimeType: string;
  size: number;
  blobPath: string;
  blobUrl: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  sessionTitle: string | null;
  sessionChannel: string | null;
};

export async function getFileForUser(input: {
  fileId: string;
  userId: string;
}): Promise<ListedFileRecord | null> {
  const [file] = await db
    .select({
      id: schema.files.id,
      sessionId: schema.files.sessionId,
      runId: schema.files.runId,
      sandboxId: schema.files.sandboxId,
      sourcePath: schema.files.sourcePath,
      fileName: schema.files.fileName,
      mimeType: schema.files.mimeType,
      size: schema.files.size,
      blobPath: schema.files.blobPath,
      blobUrl: schema.files.blobUrl,
      metadata: schema.files.metadata,
      createdAt: schema.files.createdAt,
      sessionTitle: schema.sessions.title,
      sessionChannel: schema.sessions.channel,
    })
    .from(schema.files)
    .leftJoin(schema.sessions, eq(schema.files.sessionId, schema.sessions.id))
    .where(
      and(
        eq(schema.files.id, input.fileId),
        eq(schema.sessions.userId, input.userId),
      ),
    )
    .limit(1);

  return file ?? null;
}

export async function listFiles(options: ListFilesOptions = {}): Promise<{
  files: ListedFileRecord[];
  hasMore: boolean;
  nextBefore: string | null;
}> {
  const safeLimit = Math.max(1, Math.min(options.limit ?? 30, 100));
  const sortDirection = options.sort === 'asc' ? 'asc' : 'desc';
  const filters = [];

  if (options.sessionId) {
    filters.push(eq(schema.files.sessionId, options.sessionId));
  }

  if (options.userId) {
    filters.push(eq(schema.sessions.userId, options.userId));
  }

  if (options.before) {
    filters.push(
      sortDirection === 'asc'
        ? gt(schema.files.createdAt, options.before)
        : lt(schema.files.createdAt, options.before),
    );
  }

  const whereClause =
    filters.length === 0
      ? undefined
      : filters.length === 1
        ? filters[0]
        : and(...filters);

  const baseQuery = db
    .select({
      id: schema.files.id,
      sessionId: schema.files.sessionId,
      runId: schema.files.runId,
      sandboxId: schema.files.sandboxId,
      sourcePath: schema.files.sourcePath,
      fileName: schema.files.fileName,
      mimeType: schema.files.mimeType,
      size: schema.files.size,
      blobPath: schema.files.blobPath,
      blobUrl: schema.files.blobUrl,
      metadata: schema.files.metadata,
      createdAt: schema.files.createdAt,
      sessionTitle: schema.sessions.title,
      sessionChannel: schema.sessions.channel,
    })
    .from(schema.files)
    .leftJoin(schema.sessions, eq(schema.files.sessionId, schema.sessions.id));

  const rows = await (whereClause ? baseQuery.where(whereClause) : baseQuery)
    .orderBy(
      sortDirection === 'asc'
        ? asc(schema.files.createdAt)
        : desc(schema.files.createdAt),
      sortDirection === 'asc' ? asc(schema.files.id) : desc(schema.files.id),
    )
    .limit(safeLimit + 1);

  const hasMore = rows.length > safeLimit;
  const page = hasMore ? rows.slice(0, safeLimit) : rows;
  const nextBefore =
    hasMore && page.length > 0
      ? (page[page.length - 1]?.createdAt.toISOString() ?? null)
      : null;

  return {
    files: page,
    hasMore,
    nextBefore,
  };
}
