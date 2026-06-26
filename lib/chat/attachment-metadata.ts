import type { WorkflowUIMessage } from '@/types/workflow';
import type { JSONObject } from '@ai-sdk/provider';

export const CLAWLESS_ATTACHMENT_PROVIDER = 'clawless';

export type ClawlessAttachmentSource = {
  type: 'web' | 'scheduled' | 'im' | 'cli';
  adapter?: string;
  origin?: string;
  threadId?: string;
  userId?: string | null;
  userName?: string | null;
  clientId?: string;
};

export type ClawlessAttachmentMetadata = {
  attachmentId: string;
  blobUrl: string;
  modelUrl?: string;
  originalUrl?: string;
  mediaType: string;
  filename?: string;
  size?: number;
  extractedText?: string;
  source: ClawlessAttachmentSource;
};

type FilePart = Extract<WorkflowUIMessage['parts'][number], { type: 'file' }>;
type FileProviderMetadata = NonNullable<FilePart['providerMetadata']>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

export function getClawlessAttachmentMetadata(
  part: WorkflowUIMessage['parts'][number],
): ClawlessAttachmentMetadata | null {
  if (part.type !== 'file') {
    return null;
  }

  const providerMetadata = asRecord(part.providerMetadata);
  const clawlessMetadata = asRecord(
    providerMetadata?.[CLAWLESS_ATTACHMENT_PROVIDER],
  );

  if (!clawlessMetadata) {
    return null;
  }

  const source = asRecord(clawlessMetadata.source);
  const sourceType = source?.type;
  if (
    typeof clawlessMetadata.attachmentId !== 'string' ||
    typeof clawlessMetadata.blobUrl !== 'string' ||
    typeof clawlessMetadata.mediaType !== 'string' ||
    (sourceType !== 'web' && sourceType !== 'scheduled' && sourceType !== 'im')
  ) {
    return null;
  }

  return {
    attachmentId: clawlessMetadata.attachmentId,
    blobUrl: clawlessMetadata.blobUrl,
    modelUrl:
      typeof clawlessMetadata.modelUrl === 'string'
        ? clawlessMetadata.modelUrl
        : undefined,
    originalUrl:
      typeof clawlessMetadata.originalUrl === 'string'
        ? clawlessMetadata.originalUrl
        : undefined,
    mediaType: clawlessMetadata.mediaType,
    filename:
      typeof clawlessMetadata.filename === 'string'
        ? clawlessMetadata.filename
        : undefined,
    size:
      typeof clawlessMetadata.size === 'number' &&
      Number.isFinite(clawlessMetadata.size)
        ? clawlessMetadata.size
        : undefined,
    extractedText:
      typeof clawlessMetadata.extractedText === 'string'
        ? clawlessMetadata.extractedText
        : undefined,
    source: {
      type: sourceType,
      adapter: typeof source?.adapter === 'string' ? source.adapter : undefined,
      origin: typeof source?.origin === 'string' ? source.origin : undefined,
      threadId:
        typeof source?.threadId === 'string' ? source.threadId : undefined,
      userId:
        typeof source?.userId === 'string' || source?.userId === null
          ? (source.userId as string | null)
          : undefined,
      userName:
        typeof source?.userName === 'string' || source?.userName === null
          ? (source.userName as string | null)
          : undefined,
    },
  };
}

export function attachClawlessAttachmentMetadata(
  part: FilePart,
  metadata: ClawlessAttachmentMetadata,
): FilePart {
  const providerMetadata: FileProviderMetadata = {
    ...(part.providerMetadata ?? {}),
    [CLAWLESS_ATTACHMENT_PROVIDER]: buildAttachmentProviderMetadata(metadata),
  };

  return {
    ...part,
    url: metadata.blobUrl,
    providerMetadata,
  };
}

function buildSourceProviderMetadata(
  source: ClawlessAttachmentSource,
): JSONObject {
  return {
    type: source.type,
    adapter: source.adapter,
    origin: source.origin,
    threadId: source.threadId,
    userId: source.userId,
    userName: source.userName,
  };
}

function buildAttachmentProviderMetadata(
  metadata: ClawlessAttachmentMetadata,
): JSONObject {
  return {
    attachmentId: metadata.attachmentId,
    blobUrl: metadata.blobUrl,
    modelUrl: metadata.modelUrl,
    originalUrl: metadata.originalUrl,
    mediaType: metadata.mediaType,
    filename: metadata.filename,
    size: metadata.size,
    extractedText: metadata.extractedText,
    source: buildSourceProviderMetadata(metadata.source),
  };
}

export function createAttachmentTextContext(
  metadata: ClawlessAttachmentMetadata,
): string {
  if (metadata.extractedText?.trim()) {
    return [
      `[Attachment: ${metadata.filename ?? 'unnamed file'} (${metadata.mediaType})]`,
      metadata.extractedText.trim(),
    ].join('\n');
  }

  return `[Attachment: ${metadata.filename ?? 'unnamed file'} (${metadata.mediaType}) uploaded]`;
}

export function isImageAttachmentMediaType(mediaType: string): boolean {
  return mediaType.toLowerCase().startsWith('image/');
}

export function isPdfAttachmentMediaType(mediaType: string): boolean {
  return mediaType.toLowerCase() === 'application/pdf';
}

const DOCUMENT_ATTACHMENT_MEDIA_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/markdown',
  'text/markdown',
]);

const DOCUMENT_ATTACHMENT_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'md',
  'markdown',
  'mdx',
]);

const MARKDOWN_ATTACHMENT_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);

function getFilenameExtension(filename?: string): string {
  const normalized = filename?.trim().toLowerCase();
  if (!normalized) {
    return '';
  }

  const separatorIndex = normalized.lastIndexOf('.');
  if (separatorIndex < 0 || separatorIndex === normalized.length - 1) {
    return '';
  }

  return normalized.slice(separatorIndex + 1);
}

export function isAudioOrVideoAttachmentMediaType(mediaType: string): boolean {
  const normalized = mediaType.toLowerCase();
  return normalized.startsWith('audio/') || normalized.startsWith('video/');
}

export function isDocumentAttachment(
  mediaType: string,
  filename?: string,
): boolean {
  const normalized = mediaType.toLowerCase();
  if (DOCUMENT_ATTACHMENT_MEDIA_TYPES.has(normalized)) {
    return true;
  }

  return DOCUMENT_ATTACHMENT_EXTENSIONS.has(getFilenameExtension(filename));
}

export function isMarkdownAttachment(
  mediaType: string,
  filename?: string,
): boolean {
  const normalized = mediaType.toLowerCase();
  return (
    normalized === 'text/markdown' ||
    normalized === 'application/markdown' ||
    MARKDOWN_ATTACHMENT_EXTENSIONS.has(getFilenameExtension(filename))
  );
}

export function isTextAttachmentMediaType(mediaType: string): boolean {
  const normalized = mediaType.toLowerCase();

  return (
    normalized.startsWith('text/') ||
    normalized === 'application/json' ||
    normalized === 'application/ld+json' ||
    normalized === 'application/xml' ||
    normalized === 'application/javascript' ||
    normalized === 'application/typescript' ||
    normalized === 'application/yaml' ||
    normalized === 'application/x-yaml' ||
    normalized === 'text/markdown' ||
    normalized === 'application/markdown'
  );
}
