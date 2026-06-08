import {
  type ClawlessAttachmentMetadata,
  type ClawlessAttachmentSource,
  attachClawlessAttachmentMetadata,
  getClawlessAttachmentMetadata,
  isMarkdownAttachment,
  isTextAttachmentMediaType,
} from '@/lib/chat/attachment-metadata';
import { put } from '@/lib/core/blob';
import { generateUUID } from '@/lib/utils';
import type { ChatSource, UserMessagePart } from '@/types/workflow';

const CHAT_ATTACHMENT_BLOB_ROOT = 'chat-attachments';
const MAX_EXTRACTED_TEXT_CHARS = 20_000;

type FilePart = Extract<UserMessagePart, { type: 'file' }>;

function sanitizePathSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return sanitized || 'attachment';
}

function buildAttachmentSource(source: ChatSource): ClawlessAttachmentSource {
  if (source.type === 'im') {
    return {
      type: 'im',
      adapter: source.adapter,
      origin: source.origin,
      threadId: source.threadId,
      userId: source.userId ?? null,
      userName: source.userName ?? null,
    };
  }

  return {
    type: source.type,
  };
}

function isDataUrl(value: string): boolean {
  return value.startsWith('data:');
}

function decodeDataUrl(url: string): { mediaType: string; bytes: Uint8Array } {
  const match = url.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
  if (!match) {
    throw new Error('Invalid data URL attachment.');
  }

  const [, mediaType = 'application/octet-stream', data = ''] = match;
  const bytes = Buffer.from(data, 'base64');

  return {
    mediaType,
    bytes: new Uint8Array(bytes),
  };
}

function extractTextFromBytes(
  bytes: Uint8Array,
  mediaType: string,
): string | undefined {
  if (!isTextAttachmentMediaType(mediaType)) {
    return undefined;
  }

  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const normalized = decoded.trim();

  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, MAX_EXTRACTED_TEXT_CHARS);
}

async function storeAttachmentInBlob(input: {
  sessionId: string;
  filename?: string;
  mediaType: string;
  bytes: Uint8Array;
  attachmentId: string;
}): Promise<string> {
  const pathname = [
    CHAT_ATTACHMENT_BLOB_ROOT,
    sanitizePathSegment(input.sessionId),
    `${input.attachmentId}-${sanitizePathSegment(input.filename ?? 'attachment')}`,
  ].join('/');

  const blob = await put(pathname, new Blob([Buffer.from(input.bytes)]), {
    addRandomSuffix: false,
    contentType: input.mediaType,
  });

  return blob.url;
}

async function normalizeFilePart(input: {
  sessionId: string;
  part: FilePart;
  source: ChatSource;
}): Promise<{ part: FilePart; attachment: ClawlessAttachmentMetadata }> {
  const existingMetadata = getClawlessAttachmentMetadata(input.part);
  const sourceMetadata = buildAttachmentSource(input.source);

  if (existingMetadata) {
    const nextMetadata: ClawlessAttachmentMetadata = {
      ...existingMetadata,
      filename:
        input.part.filename ?? existingMetadata.filename ?? 'Attachment',
      mediaType: input.part.mediaType || existingMetadata.mediaType,
      source: sourceMetadata,
    };

    return {
      attachment: nextMetadata,
      part: attachClawlessAttachmentMetadata(input.part, nextMetadata),
    };
  }

  const attachmentId = generateUUID();
  const filename = input.part.filename ?? 'Attachment';
  const originalUrl = input.part.url;
  let blobUrl = input.part.url;
  let extractedText: string | undefined;
  let size: number | undefined;

  if (isDataUrl(input.part.url)) {
    const { mediaType, bytes } = decodeDataUrl(input.part.url);
    const resolvedMediaType = input.part.mediaType || mediaType;
    blobUrl = await storeAttachmentInBlob({
      sessionId: input.sessionId,
      filename,
      mediaType: resolvedMediaType,
      bytes,
      attachmentId,
    });
    extractedText =
      extractTextFromBytes(bytes, resolvedMediaType) ??
      (isMarkdownAttachment(resolvedMediaType, filename)
        ? new TextDecoder('utf-8', { fatal: false })
            .decode(bytes)
            .trim()
            .slice(0, MAX_EXTRACTED_TEXT_CHARS)
        : undefined);
    size = bytes.byteLength;
  }

  const metadata: ClawlessAttachmentMetadata = {
    attachmentId,
    blobUrl,
    modelUrl: isDataUrl(originalUrl) ? originalUrl : undefined,
    originalUrl,
    mediaType: input.part.mediaType,
    filename,
    size,
    extractedText,
    source: sourceMetadata,
  };

  return {
    attachment: metadata,
    part: attachClawlessAttachmentMetadata(input.part, metadata),
  };
}

export async function normalizeUserMessageParts(input: {
  sessionId: string;
  parts: UserMessagePart[];
  source: ChatSource;
}): Promise<{
  parts: UserMessagePart[];
  attachments: ClawlessAttachmentMetadata[];
  text: string;
}> {
  const parts: UserMessagePart[] = [];
  const attachments: ClawlessAttachmentMetadata[] = [];

  for (const part of input.parts) {
    if (part.type === 'text') {
      parts.push(part);
      continue;
    }

    const normalized = await normalizeFilePart({
      sessionId: input.sessionId,
      part,
      source: input.source,
    });
    parts.push(normalized.part);
    attachments.push(normalized.attachment);
  }

  const text = parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('');

  return {
    parts,
    attachments,
    text,
  };
}
