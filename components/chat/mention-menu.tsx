'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileText, Folder } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * @ mention menu for the chat composer.
 *
 * Mirrors the slash-command menu's UX but for `@` instead of `/`. When the
 * cursor is immediately after an `@token`, this menu renders a small list of
 * suggestions the user can pick to insert as a path-like token.
 *
 * Source of suggestions:
 *  - Recently attached files (passed in via `recentAttachments`) — these are
 *    files the user has JUST dragged in, so offering them as @ targets is a
 *    natural shortcut.
 *  - Manual path entry: whatever the user typed after `@` is preserved on
 *    Enter, so `@src/utils/foo.ts` works even when the menu has no match.
 *
 * What this does NOT do: browse the user's local filesystem (impossible from
 * a browser) or browse the sandbox workspace (would need a new API and most
 * web sessions don't have a warm sandbox when the user is composing). For
 * local-file browsing use the CLI / desktop client. The web menu is a fast
 * re-reference affordance for things already in the conversation context.
 */
export interface MentionSuggestion {
  /** Display label (typically the file name). */
  label: string;
  /** Full token inserted into the textarea (without the leading @). */
  token: string;
  /** Optional description (e.g. file size or path). */
  description?: string;
  /** Whether this is a folder-like suggestion (changes the icon). */
  isFolder?: boolean;
}

type MentionMatch = {
  query: string;
  range: {
    start: number;
    end: number;
  };
};

export function getMentionMatch(
  value: string,
  cursor: number,
): MentionMatch | null {
  const beforeCursor = value.slice(0, cursor);
  // Match an `@` preceded by start-of-string or whitespace, followed by a
  // non-whitespace query (the path the user is typing). Same anchoring as
  // getSlashCommandMatch so `mailto:` / escaped `\@` don't trigger.
  const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) return null;

  const atIndex = beforeCursor.lastIndexOf('@');
  if (atIndex === -1) return null;

  return {
    query: match[1] ?? '',
    range: { start: atIndex, end: cursor },
  };
}

export function applyMention(
  value: string,
  match: MentionMatch,
  token: string,
): { nextValue: string; nextCursor: number } {
  // Insert `<token> ` (with trailing space so the next char starts a fresh
  // token). Replace the `@query` range so partial typing is overwritten.
  const insertion = `@${token} `;
  const nextValue =
    value.slice(0, match.range.start) +
    insertion +
    value.slice(match.range.end);
  const nextCursor = match.range.start + insertion.length;
  return { nextValue, nextCursor };
}

/**
 * Build the suggestion list for the current @ match. Exported for the hook
 * and for tests. Always includes a "custom" entry when the query is
 * non-empty, so manual path entry works even when no attachment matches.
 */
export function buildMentionSuggestions(
  match: MentionMatch | null,
  recentAttachments: Array<{ name: string }>,
): MentionSuggestion[] {
  if (!match) return [];
  const query = match.query.toLowerCase();

  const fromAttachments: MentionSuggestion[] = recentAttachments
    .filter((a) => a.name.toLowerCase().includes(query))
    .slice(0, 5)
    .map((a) => ({
      label: a.name,
      token: a.name,
      description: 'Recent attachment',
    }));

  const custom: MentionSuggestion[] =
    match.query.trim().length > 0
      ? [
          {
            label: match.query,
            token: match.query,
            description: 'Use as path',
            isFolder: match.query.endsWith('/'),
          },
        ]
      : [];

  // De-duplicate by token (custom may shadow an attachment of the same name).
  const seen = new Set<string>();
  return [...fromAttachments, ...custom].filter((s) => {
    if (seen.has(s.token)) return false;
    seen.add(s.token);
    return true;
  });
}

/**
 * Keyboard-navigation hook mirroring useSlashCommandNavigation. Returns
 * isOpen / activeIndex / onKeyDown so the composer can wire arrow keys,
 * Enter, Tab, and Escape exactly like the slash-command flow.
 */
export function useMentionNavigation(
  value: string,
  cursor: number,
  recentAttachments: Array<{ name: string }>,
  onSelect: (token: string) => void,
) {
  const match = useMemo(() => getMentionMatch(value, cursor), [cursor, value]);
  const items = useMemo(
    () => buildMentionSuggestions(match, recentAttachments),
    [match, recentAttachments],
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const boundedActiveIndex = activeIndex >= items.length ? 0 : activeIndex;

  // Reset to the first item whenever the suggestion set changes shape,
  // so a stale highlight doesn't land on an out-of-range index.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setActiveIndex is a stable state setter
  useEffect(() => {
    setActiveIndex(0);
  }, [match?.query]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (items.length === 0) return false;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((current) => (current + 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex(
          (current) => (current - 1 + items.length) % items.length,
        );
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setActiveIndex(0);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const picked = items[boundedActiveIndex] ?? items[0];
        if (picked) onSelect(picked.token);
        return true;
      }
      return false;
    },
    [items, boundedActiveIndex, onSelect],
  );

  return {
    isOpen: items.length > 0,
    activeIndex: boundedActiveIndex,
    setActiveIndex,
    items,
    onKeyDown,
  };
}

type MentionMenuProps = {
  value: string;
  cursor: number;
  activeIndex: number;
  recentAttachments: Array<{ name: string }>;
  onSelect: (token: string) => void;
  className?: string;
};

export function MentionMenu({
  value,
  cursor,
  activeIndex,
  recentAttachments,
  onSelect,
  className,
}: MentionMenuProps) {
  const match = useMemo(() => getMentionMatch(value, cursor), [cursor, value]);
  const items = useMemo(
    () => buildMentionSuggestions(match, recentAttachments),
    [match, recentAttachments],
  );

  if (!match || items.length === 0) return null;

  return (
    <Card
      className={cn(
        'absolute inset-x-3 bottom-[calc(100%+0.75rem)] z-20 overflow-hidden border-border/70 bg-background/95 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/85',
        className,
      )}
    >
      <div className="border-border/60 border-b px-3 py-2">
        <p className="font-medium text-foreground text-xs">Reference</p>
        <p className="text-muted-foreground text-xs">
          Type a path after @ and press Enter to point the agent at a file or
          folder. The agent will read it from the sandbox / local context.
        </p>
      </div>

      <div className="max-h-64 overflow-y-auto p-2">
        {items.map((item, index) => {
          const isActive = index === activeIndex;
          const Icon = item.isFolder ? Folder : FileText;
          return (
            <button
              key={`${item.token}-${index}`}
              type="button"
              className={cn(
                'flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left transition-colors',
                isActive
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/70',
              )}
              onMouseEnter={() => {
                /* no-op: hover highlight is via activeIndex from parent */
              }}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(item.token);
              }}
            >
              <span className="mt-0.5 rounded-md border border-border/60 bg-muted p-1.5 text-muted-foreground">
                <Icon className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-3">
                  <span className="truncate font-mono text-sm">
                    @{item.token}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {item.description}
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}
