/**
 * Header chip registry — quantitative suffix shown alongside a tool's
 * status line (e.g. `exit 0`, `42 lines`, `+3 -1`, `5 matches`).
 *
 * Inspired by kimi-code's chip registry; adapted to this fork's
 * per-tool renderResult(text) shape. Each provider returns a short
 * plain string (no color); callers wrap it with the muted tone.
 */

export type ToolChipProvider = (
  result: {
    content: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    details?: any;
  },
  options: { isPartial: boolean; isError: boolean },
) => string | undefined;

/** Bash: surface the exit code from details (when available) or error text. */
export const bashChip: ToolChipProvider = (result, options) => {
  if (options.isPartial) return undefined;
  const exitCode = result.details?.exitCode;
  if (typeof exitCode === 'number') {
    return options.isError ? `exit ${exitCode}` : `exit ${exitCode}`;
  }
  return undefined;
};

/** Read: count non-empty lines of the text content. */
export const readChip: ToolChipProvider = (result, options) => {
  if (options.isPartial) return undefined;
  const text = result.content.find((c) => c.type === 'text')?.text ?? '';
  const lines = text.split('\n').filter((l) => l.trim().length > 0).length;
  return lines === 1 ? '1 line' : `${lines} lines`;
};

/** Write: count lines of the written content from details, if known. */
export const writeChip: ToolChipProvider = (result, options) => {
  if (options.isPartial) return undefined;
  const text = result.content.find((c) => c.type === 'text')?.text ?? '';
  const match = text.match(/Wrote\s+\d+\s+bytes/);
  return match ? match[0] : undefined;
};

/** Grep: parse match count from the result text (best-effort). */
export const grepChip: ToolChipProvider = (result, options) => {
  if (options.isPartial) return undefined;
  const text = result.content.find((c) => c.type === 'text')?.text ?? '';
  const match = text.match(/\b(\d+)\s+matches?\b/i);
  if (match) return `${match[1]} matches`;
  if (/\bno matches\b/i.test(text)) return 'no matches';
  return undefined;
};

/** Glob / find: count non-empty result lines as file count. */
export const globChip: ToolChipProvider = (result, options) => {
  if (options.isPartial) return undefined;
  const text = result.content.find((c) => c.type === 'text')?.text ?? '';
  const count = text.split('\n').filter((l) => l.trim().length > 0).length;
  return count === 0 ? 'no files' : `${count} files`;
};

const REGISTRY: Record<string, ToolChipProvider> = {
  // Thin-client local tools (the names Web workflow emits via SSE for
  // tools executed on the CLI host — see handleLocalToolRequest).
  local_exec: bashChip,
  local_read_file: readChip,
  local_write_file: writeChip,
  // pi-native tool names (shown when Web forwards a toolUse event for
  // a tool that ran on the Web workflow / agentd rather than locally).
  bash: bashChip,
  read: readChip,
  write: writeChip,
  grep: grepChip,
  find: globChip,
  ls: globChip,
};

/**
 * Resolve a chip string for a tool result. Returns `undefined` when the
 * tool has no provider or the provider declines.
 */
export function getToolChip(
  toolName: string,
  result: {
    content: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    details?: any;
  },
  options: { isPartial: boolean; isError: boolean },
): string | undefined {
  const provider = REGISTRY[toolName];
  return provider?.(result, options);
}
