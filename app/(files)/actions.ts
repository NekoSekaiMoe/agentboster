'use server';

import { readAuthSessionFromCookies } from '@/lib/auth';
import { listFiles } from '@/lib/core/db/files';
import { cookies } from 'next/headers';

export type FileRecord = {
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
  createdAt: string;
  sessionTitle: string | null;
  sessionChannel: string | null;
};

export type FilesListResponse = {
  files: FileRecord[];
  hasMore: boolean;
  nextBefore: string | null;
};

async function requireAuth() {
  const cookieStore = await cookies();
  const authSession = await readAuthSessionFromCookies(cookieStore);

  if (!authSession) {
    throw new Error('Unauthorized');
  }

  return authSession;
}

function parseLimit(raw: number | null | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return 30;
  }

  return raw;
}

function parseBefore(raw: string | null | undefined): Date | undefined {
  if (!raw) {
    return undefined;
  }

  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    return undefined;
  }

  return value;
}

export async function listFilesAction(input?: {
  before?: string | null;
  limit?: number;
  sessionId?: string | null;
  sort?: 'asc' | 'desc';
}): Promise<FilesListResponse> {
  await requireAuth();

  const result = await listFiles({
    sessionId: input?.sessionId?.trim() || undefined,
    limit: parseLimit(input?.limit),
    before: parseBefore(input?.before),
    sort: input?.sort === 'asc' ? 'asc' : 'desc',
  });

  return {
    files: result.files.map((file) => ({
      id: file.id,
      sessionId: file.sessionId,
      runId: file.runId,
      sandboxId: file.sandboxId,
      sourcePath: file.sourcePath,
      fileName: file.fileName,
      mimeType: file.mimeType,
      size: file.size,
      blobPath: file.blobPath,
      blobUrl: file.blobUrl,
      metadata: file.metadata,
      createdAt: file.createdAt.toISOString(),
      sessionTitle: file.sessionTitle,
      sessionChannel: file.sessionChannel,
    })),
    hasMore: result.hasMore,
    nextBefore: result.nextBefore,
  };
}
