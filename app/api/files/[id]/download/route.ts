import { requireAuthAccess } from '@/lib/auth/access';
import { getBlob } from '@/lib/core/blob';
import { getFileById, getFileForUser } from '@/lib/core/db/files';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

function encodeContentDispositionFilename(filename: string): string {
  const fallback = filename.replace(/["\r\n\\]/g, '_') || 'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const cookieStore = await cookies();
  let access: Awaited<ReturnType<typeof requireAuthAccess>>;
  try {
    access = await requireAuthAccess(cookieStore);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const ownedFile = await getFileForUser({
    fileId: id,
    userId: access.session.userId,
  });
  const file = ownedFile ?? (access.isAdmin ? await getFileById(id) : null);

  if (!file) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  const blob = await getBlob(file.blobPath);
  if (blob?.statusCode !== 200) {
    return NextResponse.json({ error: 'Blob not found' }, { status: 404 });
  }

  return new Response(blob.stream, {
    headers: {
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'Content-Disposition': encodeContentDispositionFilename(file.fileName),
      'Content-Type': blob.blob.contentType || file.mimeType,
    },
  });
}
