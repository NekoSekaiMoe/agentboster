/**
 * Process @file CLI arguments into text content and image attachments
 */

import { access, readFile, stat } from 'node:fs/promises';
import type { ImageContent } from '@agentboster-cli/ai';
import chalk from 'chalk';
import { resolve } from 'path';
import { resolveReadPath } from '../core/tools/path-utils.ts';
import { processImage } from '../utils/image-process.ts';
import { detectSupportedImageMimeTypeFromFile } from '../utils/mime.ts';

export interface ProcessedFiles {
  text: string;
  images: ImageContent[];
}

export interface ProcessFileOptions {
  /** Whether to auto-resize images to 2000x2000 max. Default: true */
  autoResizeImages?: boolean;
}

/** Process @file arguments into text content and image attachments */
export async function processFileArguments(
  fileArgs: string[],
  options?: ProcessFileOptions,
): Promise<ProcessedFiles> {
  const autoResizeImages = options?.autoResizeImages ?? true;
  let text = '';
  const images: ImageContent[] = [];

  for (const fileArg of fileArgs) {
    // Expand and resolve path (handles ~ expansion and macOS screenshot Unicode spaces)
    const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

    // Check if file exists
    try {
      await access(absolutePath);
    } catch {
      console.error(chalk.red(`Error: File not found: ${absolutePath}`));
      process.exit(1);
    }

    // Check if file is empty
    const stats = await stat(absolutePath);
    if (stats.size === 0) {
      // Skip empty files
      continue;
    }

    const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);

    if (mimeType) {
      // Handle image file
      const content = await readFile(absolutePath);
      const processed = await processImage(content, mimeType, {
        autoResizeImages,
      });

      if (!processed.ok) {
        text += `<file name="${absolutePath}">${processed.message}</file>\n`;
        continue;
      }

      const attachment: ImageContent = {
        type: 'image',
        mimeType: processed.mimeType,
        data: processed.data,
      };
      images.push(attachment);

      // Add text reference to image with optional processing hints
      if (processed.hints.length > 0) {
        text += `<file name="${absolutePath}">${processed.hints.join('\n')}</file>\n`;
      } else {
        text += `<file name="${absolutePath}"></file>\n`;
      }
    } else {
      // Handle text file
      try {
        const content = await readFile(absolutePath, 'utf-8');
        text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          chalk.red(`Error: Could not read file ${absolutePath}: ${message}`),
        );
        process.exit(1);
      }
    }
  }

  return { text, images };
}

/**
 * Result of inline @-mention expansion in a chat message.
 *
 * - `text`: the original message with every expandable `@token` REPLACED
 *   in-place by its `<file>` block (or left untouched when the token did not
 *   resolve to a readable file). Note this differs from
 *   `processFileArguments`, which APPENDS to an accumulator — inline mode
 *   preserves the user's prose ordering.
 * - `images`: image attachments discovered while expanding (treated exactly
 *   like the startup `@image.png` path: resize, embed, leave a `<file>` stub).
 * - `missedTokens`: `@tokens` that did not resolve to a readable file. The
 *   caller decides whether to warn the user or pass them through verbatim
 *   (they may be intentional mentions like `@team-handle` or an email).
 */
export interface ExpandedMentions {
  text: string;
  images: ImageContent[];
  missedTokens: string[];
}

// Match `@token` where @ is preceded by start-of-string or whitespace, and
// the token is a non-whitespace run that looks path-ish (contains `/`, `.`,
// or `_` — common in file paths but not in chat handles like `@john`).
// Anchoring + path-ish filter together eliminate the vast majority of
// false positives in normal prose without needing a filesystem stat.
const INLINE_MENTION_RE =
  /(?:^|\s)@([^\s@]+(\/[^\s@]+|\.[A-Za-z0-9]+|_[A-Za-z0-9]+))/g;

/**
 * Expand inline `@file` / `@dir/file` mentions inside a chat message into
 * `<file>` blocks, mirroring what the startup `@file` CLI arg path does —
 * but operating on tokens embedded in prose rather than standalone argv.
 *
 * Used by the interactive editor's submit handler so typing
 * `fix the bug in @src/utils/foo.ts please` actually pulls the file
 * contents into the prompt, instead of sending the literal `@src/...`
 * string to the model.
 *
 * Behavior:
 * - `@token` not path-ish → left untouched (email / handle / emphasis).
 * - `@token` path-ish but file not found → left untouched AND recorded in
 *   `missedTokens` so the UI can warn the user without blocking send.
 * - `@token` resolves to an image → image attached + `<file name="..." />`
 *   stub replaces the token in prose.
 * - `@token` resolves to text → `<file name="...">content</file>` replaces
 *   the token in prose.
 *
 * Path resolution reuses resolveReadPath so `~`, relative paths, and macOS
 * screenshot NFD quirks all work the same as the startup path.
 */
export async function expandInlineAtMentions(
  message: string,
  cwd: string,
  options?: ProcessFileOptions & {
    /**
     * How to handle @tokens that resolve to image files.
     *
     * - 'embed' (default): read the image, attach it, leave a `<file>` stub
     *   in prose. Matches the startup `@img.png` behavior.
     * - 'skip': record the token in `missedTokens` (with an '(image)' hint)
     *   and leave the @token untouched in prose. Used by interactive mode,
     *   where threading attached images through every session.prompt
     *   branch is impractical — users drag-and-drop images instead.
     */
    inlineImageHandling?: 'embed' | 'skip';
  },
): Promise<ExpandedMentions> {
  const autoResizeImages = options?.autoResizeImages ?? true;
  const inlineImageHandling = options?.inlineImageHandling ?? 'embed';
  const images: ImageContent[] = [];
  const missedTokens: string[] = [];

  // Walk matches and collect replacement spans. We can't `replace` inline
  // because each expansion is async; collect first, then apply in reverse
  // so earlier spans' indices stay valid.
  type Span = {
    start: number;
    end: number;
    original: string;
    replacement: string;
  };
  const spans: Span[] = [];

  for (const match of message.matchAll(INLINE_MENTION_RE)) {
    const token = match[1];
    if (!token) continue;
    // match[0] includes the leading whitespace; we only want to replace the
    // @token portion so the user's original spacing is preserved.
    const fullMatchStart = match.index ?? 0;
    const atOffset = match[0].lastIndexOf('@');
    const atStart = fullMatchStart + atOffset;
    const atEnd = atStart + 1 + token.length;

    const absolutePath = resolve(resolveReadPath(token, cwd));
    let exists = true;
    try {
      await access(absolutePath);
    } catch {
      exists = false;
    }
    if (!exists) {
      missedTokens.push(token);
      continue;
    }

    const stats = await stat(absolutePath).catch(() => null);
    if (!stats) {
      missedTokens.push(token);
      continue;
    }
    if (stats.size === 0) {
      // Skip empty files — same as the startup path.
      spans.push({
        start: atStart,
        end: atEnd,
        original: `@${token}`,
        replacement: '',
      });
      continue;
    }

    const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
    if (mimeType) {
      if (inlineImageHandling === 'skip') {
        // Defer to the caller: leave the token in place and flag it so the
        // UI can suggest drag-and-drop. Avoids silently dropping images in
        // interactive mode where prompt() branches don't all thread images.
        missedTokens.push(`${token} (image)`);
        continue;
      }
      const content = await readFile(absolutePath);
      const processed = await processImage(content, mimeType, {
        autoResizeImages,
      });
      if (!processed.ok) {
        spans.push({
          start: atStart,
          end: atEnd,
          original: `@${token}`,
          replacement: `<file name="${absolutePath}">${processed.message}</file>`,
        });
        continue;
      }
      images.push({
        type: 'image',
        mimeType: processed.mimeType,
        data: processed.data,
      });
      const stub =
        processed.hints.length > 0
          ? `<file name="${absolutePath}">${processed.hints.join('\n')}</file>`
          : `<file name="${absolutePath}"></file>`;
      spans.push({
        start: atStart,
        end: atEnd,
        original: `@${token}`,
        replacement: stub,
      });
      continue;
    }

    try {
      const content = await readFile(absolutePath, 'utf-8');
      spans.push({
        start: atStart,
        end: atEnd,
        original: `@${token}`,
        replacement: `<file name="${absolutePath}">\n${content}\n</file>`,
      });
    } catch {
      missedTokens.push(token);
    }
  }

  if (spans.length === 0) {
    return { text: message, images, missedTokens };
  }

  spans.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += message.slice(cursor, span.start);
    out += span.replacement;
    cursor = span.end;
  }
  out += message.slice(cursor);

  return { text: out, images, missedTokens };
}
