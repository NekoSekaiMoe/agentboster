'use client';

import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { FileRecord } from '@/app/(files)/actions';
import { Markdown } from '@/components/markdown';

/**
 * File preview panel.
 *
 * Renders a single FileRecord inline based on its mimeType, without leaving
 * the page. Routes by mime:
 *   - image/*            -> <img>
 *   - application/pdf    -> <iframe> (browser-native PDF viewer, zero deps)
 *   - text/markdown      -> <Markdown> (mermaid/katex/diff included)
 *   - text/*, application/json -> <pre> with fetched text
 *   - everything else    -> download hint
 *
 * Text content is fetched from the blob URL on demand; binary formats are
 * pointed at directly (img/iframe stream from the blob URL).
 */
export function FilePreviewPanel({
  file,
  onClose,
}: {
  file: FileRecord;
  onClose?: () => void;
}) {
  const kind = classifyMime(file.mimeType, file.fileName);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Focus management: move focus into the panel on mount and restore it to
  // the previously-focused element (the triggering control) on unmount.
  // Escape dismisses the preview.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose?.();
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
      <div className="flex items-center justify-between border-zinc-200 border-b px-4 py-2 dark:border-zinc-700">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-sm text-zinc-900 dark:text-zinc-100">
            {file.fileName}
          </div>
          <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {file.mimeType || kind} · {formatBytes(file.size)}
          </div>
        </div>
        {onClose && (
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={file.fileName}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="flex-1 overflow-auto outline-none"
      >
        <PreviewBody file={file} kind={kind} />
      </div>
    </div>
  );
}

type PreviewKind =
  | 'image'
  | 'pdf'
  | 'markdown'
  | 'text'
  | 'json'
  | 'audio'
  | 'video'
  | 'other';

function PreviewBody({ file, kind }: { file: FileRecord; kind: PreviewKind }) {
  const url = file.blobUrl;
  switch (kind) {
    case 'image':
      return (
        <div className="flex min-h-full items-center justify-center bg-zinc-50 p-4 dark:bg-zinc-950/40">
          {/* biome-ignore lint/performance/noImgElement: blob URLs are not compatible with next/image */}
          <img
            src={url}
            alt={file.fileName}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      );
    case 'pdf':
      return (
        <iframe
          src={url}
          title={file.fileName}
          className="h-full min-h-[60vh] w-full border-0"
        />
      );
    case 'audio':
      return (
        <div className="flex items-center justify-center p-8">
          <audio src={url} controls className="w-full max-w-xl">
            <track kind="captions" />
          </audio>
        </div>
      );
    case 'video':
      return (
        <div className="flex items-center justify-center p-4">
          <video src={url} controls className="max-h-[70vh] max-w-full">
            <track kind="captions" />
          </video>
        </div>
      );
    case 'markdown':
      return <MarkdownFetcher url={url} renderMarkdown />;
    case 'json':
      return <MarkdownFetcher url={url} renderJson />;
    case 'text':
      return <MarkdownFetcher url={url} />;
    default:
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
          <span>此文件类型不支持在线预览</span>
          <a
            href={url}
            download={file.fileName}
            className="text-blue-500 hover:underline"
          >
            下载 {file.fileName}
          </a>
        </div>
      );
  }
}

/**
 * Fetch a text/markdown/json blob and render it. Keeps the fetched body in
 * state; re-fetches when `url` changes.
 */
function MarkdownFetcher({
  url,
  renderMarkdown,
  renderJson,
}: {
  url: string;
  renderMarkdown?: boolean;
  renderJson?: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error) {
    return <div className="p-4 text-red-500 text-sm">加载失败:{error}</div>;
  }
  if (text === null) {
    return <div className="p-4 text-sm text-zinc-400">加载中...</div>;
  }
  if (renderMarkdown) {
    return (
      <div className="p-4 text-sm">
        <Markdown>{text}</Markdown>
      </div>
    );
  }
  if (renderJson) {
    return (
      <pre className="overflow-x-auto p-4 text-xs">
        <code>{tryPrettyJson(text)}</code>
      </pre>
    );
  }
  return (
    <pre className="overflow-x-auto p-4 text-xs">
      <code>{text}</code>
    </pre>
  );
}

function classifyMime(mime: string, fileName: string): PreviewKind {
  const m = mime.toLowerCase();
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (m.startsWith('image/')) return 'image';
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (
    m === 'text/markdown' ||
    m === 'text/x-markdown' ||
    ['md', 'markdown', 'mdx'].includes(ext)
  )
    return 'markdown';
  if (m === 'application/json' || ext === 'json') return 'json';
  if (
    m.startsWith('text/') ||
    [
      'txt',
      'log',
      'ts',
      'tsx',
      'js',
      'jsx',
      'py',
      'go',
      'rs',
      'java',
      'c',
      'cpp',
      'h',
      'sh',
      'yml',
      'yaml',
      'toml',
      'ini',
      'csv',
    ].includes(ext)
  )
    return 'text';
  return 'other';
}

function tryPrettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}
