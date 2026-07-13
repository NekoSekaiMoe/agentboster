/**
 * Blob proxy route (self-hosted only).
 *
 * Streams an S3/MinIO object to the caller after verifying the HMAC signature
 * minted by `signBlobUrl` (proxy-link.ts). This is the public, cookie-less
 * endpoint whose URL is handed to LLM providers and rendered in the web UI,
 * mirroring the signed-link pattern of `/api/l2`.
 *
 * On Vercel this route is inert: `put()` returns a native Vercel Blob URL, so
 * nothing ever points here. We still guard with `isVercel` to avoid doing S3
 * work in a deployment that has no S3 configured.
 */
import { getBlob } from '@/lib/core/blob';
import { verifyBlobUrl } from '@/lib/core/blob/proxy-link';
import { isVercel } from '@/lib/deploy';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (isVercel) {
    return NextResponse.json(
      { error: 'Blob proxy is only available on self-hosted deployments' },
      { status: 404 },
    );
  }

  const { path } = await params;
  const blobPath = path.map((segment) => decodeURIComponent(segment)).join('/');

  const url = new URL(request.url);
  const verification = await verifyBlobUrl({
    blobPath,
    expiresParam: url.searchParams.get('t'),
    signatureParam: url.searchParams.get('s'),
  });

  if (!verification.ok) {
    const status = verification.reason === 'expired' ? 410 : 403;
    return NextResponse.json(
      { error: `Blob access denied: ${verification.reason}` },
      { status },
    );
  }

  const blob = await getBlob(blobPath);
  if (blob?.statusCode !== 200) {
    return NextResponse.json({ error: 'Blob not found' }, { status: 404 });
  }

  return new Response(blob.stream, {
    headers: {
      // Signed URL already bounds access; allow browser/CDN caching for the
      // lifetime of the signature. Private so shared caches don't retain it.
      'Cache-Control': 'private, max-age=3600',
      'Content-Type': blob.blob.contentType || 'application/octet-stream',
    },
  });
}
