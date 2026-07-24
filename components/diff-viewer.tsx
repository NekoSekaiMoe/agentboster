'use client';

import { useMemo } from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';

/**
 * Unified-diff renderer for code blocks whose language is `diff` or whose
 * body looks like a unified diff (lines starting with +/-/@@).
 *
 * Falls back to a normal <pre> code block if the content isn't a diff, so a
 * ```diff fenced block that actually contains prose still renders sanely.
 */
export function DiffViewer({ code }: { code: string }) {
  const { left, right, isDiff } = useMemo(() => parseDiff(code), [code]);

  if (!isDiff) {
    return (
      <pre className="w-full overflow-x-auto rounded-xl border border-zinc-200 p-4 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50">
        <code className="whitespace-pre-wrap break-words">{code}</code>
      </pre>
    );
  }

  return (
    <div className="not-prose my-2 overflow-hidden rounded-xl border border-zinc-200 text-sm dark:border-zinc-700">
      <ReactDiffViewer
        oldValue={left}
        newValue={right}
        splitView={false}
        hideLineNumbers={false}
        useDarkTheme={false}
        compareMethod={DiffMethod.WORDS}
        styles={{
          variables: {
            dark: {
              diffViewerBackground: 'transparent',
            },
          },
        }}
      />
    </div>
  );
}

/**
 * Parse a unified-diff string into (oldText, newText). Walks hunks line by
 * line: lines starting with '-' go to old, '+' to new, ' ' (context) to both,
 * '@@ ... @@' are hunk headers (ignored). Returns isDiff=false when the input
 * has no diff markers so the caller can fall back to a plain code block.
 */
function parseDiff(input: string): {
  left: string;
  right: string;
  isDiff: boolean;
} {
  const lines = input.split('\n');
  let minus = 0;
  let plus = 0;
  let atAt = 0;
  const left: string[] = [];
  const right: string[] = [];
  for (const line of lines) {
    if (line.startsWith('@@')) {
      atAt++;
      continue;
    }
    if (line.startsWith('-')) {
      minus++;
      left.push(line.slice(1));
    } else if (line.startsWith('+')) {
      plus++;
      right.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      left.push(line.slice(1));
      right.push(line.slice(1));
    } else {
      // Bare lines (no diff prefix) — treat as context on both sides so a
      // partial diff still aligns.
      left.push(line);
      right.push(line);
    }
  }
  // Require at least one hunk header and at least one +/- to call it a diff.
  const isDiff = atAt > 0 && (minus > 0 || plus > 0);
  return { left: left.join('\n'), right: right.join('\n'), isDiff };
}
