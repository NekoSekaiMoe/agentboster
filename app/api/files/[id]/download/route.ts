import { readAuthSessionFromCookies } from '@/lib/auth';
import { getBlob } from '@/lib/core/blob';
import { getFileForUser } from '@/lib/core/db/files';
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
  const session = await readAuthSessionFromCookies(cookieStore);

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const file = await getFileForUser({ fileId: id, userId: session.userId });

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
