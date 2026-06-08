'use client';

import type { WorkflowUIMessage } from '@/types/workflow';
import { XIcon } from 'lucide-react';

import { AttachmentIcon, FileIcon } from './icons';
import { Button } from './ui/button';

export type ComposerAttachment = {
  id: string;
  name: string;
  mediaType: string;
  providerMetadata?: Extract<
    WorkflowUIMessage['parts'][number],
    { type: 'file' }
  >['providerMetadata'];
  url: string;
  size: number;
};

export type AttachmentUploadProgress = {
  id: string;
  name: string;
  loaded: number;
  total: number;
  status: 'reading' | 'processing';
};

export function buildAttachmentId(file: File) {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

export async function fileToComposerAttachment(
  file: File,
  onProgress?: (progress: AttachmentUploadProgress) => void,
): Promise<ComposerAttachment> {
  const id = buildAttachmentId(file);
  return {
    id,
    name: file.name,
    mediaType: file.type || 'application/octet-stream',
    providerMetadata: undefined,
    url: await readFileAsDataUrl(file, (loaded, total) => {
      onProgress?.({
        id,
        name: file.name,
        loaded,
        total,
        status: 'reading',
      });
    }),
    size: file.size,
  };
}

export function filePartToComposerAttachment(
  part: Extract<WorkflowUIMessage['parts'][number], { type: 'file' }>,
): ComposerAttachment {
  const name =
    typeof part.filename === 'string' && part.filename.trim().length > 0
      ? part.filename
      : 'Attachment';

  return {
    id: `${name}-${part.url}`,
    name,
    mediaType: part.mediaType,
    providerMetadata: part.providerMetadata,
    url: part.url,
    size: 0,
  };
}

function readFileAsDataUrl(
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onprogress = (event) => {
      onProgress?.(
        event.loaded,
        event.lengthComputable ? event.total : file.size,
      );
    };
    reader.onload = () => {
      onProgress?.(file.size, file.size);
      resolve(String(reader.result ?? ''));
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

export function AttachmentList({
  attachments,
  onRemove,
  uploadProgress = [],
}: {
  attachments: ComposerAttachment[];
  onRemove?: (id: string) => void;
  uploadProgress?: AttachmentUploadProgress[];
}) {
  if (attachments.length === 0 && uploadProgress.length === 0) {
    return null;
  }

  return (
    <div className="h-fit overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex min-w-max gap-2 pr-1">
        {uploadProgress.map((progress) => {
          const total = progress.total > 0 ? progress.total : 1;
          const percent = Math.min(
            100,
            Math.round((progress.loaded / total) * 100),
          );

          return (
            <div
              key={progress.id}
              className="inline-flex max-w-[240px] shrink-0 items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-foreground text-sm shadow-sm"
            >
              <FileIcon size={14} />
              <span className="max-w-28 truncate">{progress.name}</span>
              <span className="text-muted-foreground text-xs tabular-nums">
                {progress.status === 'processing'
                  ? 'processing'
                  : `${percent}%`}
              </span>
              <span className="h-1 w-14 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${percent}%` }}
                />
              </span>
            </div>
          );
        })}
        {attachments.map((attachment) => (
          <div
            key={attachment.id}
            className="inline-flex max-w-[220px] shrink-0 items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-foreground text-sm shadow-sm"
          >
            <FileIcon size={14} />
            <span className="truncate">
              {attachment.name.length > 5
                ? `${attachment.name.substring(0, 5)}...`
                : attachment.name}
            </span>
            {onRemove ? (
              <button
                type="button"
                className="rounded-full text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => onRemove(attachment.id)}
                aria-label={`Remove ${attachment.name}`}
              >
                <XIcon className="size-3.5" />
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function AttachmentButton({
  disabled,
  onClick,
}: {
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8 rounded-full text-muted-foreground hover:text-foreground"
      onClick={onClick}
      disabled={disabled}
      aria-label="Add attachments"
    >
      <AttachmentIcon />
    </Button>
  );
}
