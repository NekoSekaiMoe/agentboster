'use client';

import {
  BookOpen,
  Database,
  Hash,
  Info,
  KeyRound,
  Languages,
  Play,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  UserCircle2,
  Wand2,
  X,
} from 'lucide-react';
import type React from 'react';
import { useMemo, useState } from 'react';

import { useI18n } from '@/components/i18n-provider';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { COMMANDS, type Command } from '@/types/workflow';

type SlashCommandDefinition = {
  command: Command;
  description: string;
  hint: string;
  icon: typeof Wand2;
};

// Static metadata (icon only). description + hint come from i18n at
// render time via useSlashCommands() so they pick up the active locale.
const COMMAND_ICONS: Record<Command, typeof Wand2> = {
  new: Wand2,
  compact: Hash,
  init: BookOpen,
  help: Search,
  stop: Square,
  status: Play,
  session: Hash,
  sessions: Search,
  switch: Hash,
  delete_session: Trash2,
  approve: ThumbsUp,
  reject: ThumbsDown,
  decisions: Search,
  model: Hash,
  provider: Settings,
  config: Settings,
  memory: Database,
  pair: KeyRound,
  unpair: KeyRound,
  whoami: UserCircle2,
  start: Sparkles,
  cancel: X,
  reset: RotateCcw,
  retry: RotateCcw,
  version: Info,
  id: Hash,
  lang: Languages,
  remote: Search,
  attach: Play,
  detach: X,
};

/**
 * Build the localized slash command list. Re-runs whenever the locale
 * changes (i18n provider falls back to en-US when a key is missing).
 */
export function useSlashCommands(): SlashCommandDefinition[] {
  const { t } = useI18n();
  return useMemo<SlashCommandDefinition[]>(
    () =>
      COMMANDS.map((command) => {
        const descriptionKey = `slash.command.${command}.description`;
        const hintKey = `slash.command.${command}.hint`;
        return {
          command,
          description: t(descriptionKey as never),
          hint: t(hintKey as never),
          icon: COMMAND_ICONS[command],
        };
      }),
    [t],
  );
}

type SlashCommandMatch = {
  query: string;
  range: {
    start: number;
    end: number;
  };
};

export function getSlashCommandMatch(
  value: string,
  cursor: number,
): SlashCommandMatch | null {
  const beforeCursor = value.slice(0, cursor);
  const match = beforeCursor.match(/(?:^|\s)\/([^\s/]*)$/);

  if (!match) {
    return null;
  }

  const slashIndex = beforeCursor.lastIndexOf('/');
  if (slashIndex === -1) {
    return null;
  }

  return {
    query: match[1] ?? '',
    range: {
      start: slashIndex,
      end: cursor,
    },
  };
}

export function applySlashCommand(
  value: string,
  match: SlashCommandMatch,
  command: Command,
): { nextValue: string; nextCursor: number } {
  const insertion = `/${command} `;
  const nextValue =
    value.slice(0, match.range.start) +
    insertion +
    value.slice(match.range.end);
  const nextCursor = match.range.start + insertion.length;

  return { nextValue, nextCursor };
}

type SlashCommandMenuProps = {
  value: string;
  cursor: number;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (command: Command) => void;
  className?: string;
};

export function SlashCommandMenu({
  value,
  cursor,
  activeIndex,
  onActiveIndexChange,
  onSelect,
  className,
}: SlashCommandMenuProps) {
  const allCommands = useSlashCommands();
  const match = useMemo(
    () => getSlashCommandMatch(value, cursor),
    [cursor, value],
  );
  const items = useMemo(() => {
    if (!match) {
      return [];
    }

    const query = match.query.toLowerCase();
    return allCommands.filter(({ command }) => command.startsWith(query));
  }, [match, allCommands]);

  if (!match || items.length === 0) {
    return null;
  }

  return (
    <Card
      className={cn(
        'absolute inset-x-3 bottom-[calc(100%+0.75rem)] z-20 overflow-hidden border-border/70 bg-background/95 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/85',
        className,
      )}
    >
      <div className="border-border/60 border-b px-3 py-2">
        <p className="font-medium text-foreground text-xs">Commands</p>
        <p className="text-muted-foreground text-xs">
          Type a slash command, then press Enter or click to insert it.
        </p>
      </div>

      <div className="max-h-64 overflow-y-auto p-2">
        {items.map((item, index) => {
          const Icon = item.icon;
          const isActive = index === activeIndex;

          return (
            <button
              key={item.command}
              type="button"
              className={cn(
                'flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left transition-colors',
                isActive
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/70',
              )}
              onMouseEnter={() => onActiveIndexChange(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(item.command);
              }}
            >
              <span className="mt-0.5 rounded-md border border-border/60 bg-muted p-1.5 text-muted-foreground">
                <Icon className="size-3.5" />
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-3">
                  <span className="truncate font-medium text-sm">
                    /{item.command}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {item.hint}
                  </span>
                </span>
                <span className="mt-0.5 block text-muted-foreground text-xs">
                  {item.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

export function useSlashCommandNavigation(
  value: string,
  cursor: number,
  onSelect: (command: Command) => void,
) {
  const allCommands = useSlashCommands();
  const match = useMemo(
    () => getSlashCommandMatch(value, cursor),
    [cursor, value],
  );
  const items = useMemo(() => {
    if (!match) {
      return [];
    }

    const query = match.query.toLowerCase();
    return allCommands.filter(({ command }) => command.startsWith(query));
  }, [match, allCommands]);
  const [activeIndex, setActiveIndex] = useState(0);
  const boundedActiveIndex = activeIndex >= items.length ? 0 : activeIndex;

  return {
    isOpen: items.length > 0,
    activeIndex: boundedActiveIndex,
    setActiveIndex,
    items,
    onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (items.length === 0) {
        return false;
      }

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
        onSelect(items[boundedActiveIndex]?.command ?? items[0].command);
        return true;
      }

      return false;
    },
  };
}
