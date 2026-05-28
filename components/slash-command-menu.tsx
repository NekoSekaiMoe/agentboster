'use client';

import {
  BookOpen,
  Database,
  Hash,
  KeyRound,
  Play,
  Search,
  Settings,
  Square,
  ThumbsDown,
  ThumbsUp,
  Wand2,
} from 'lucide-react';
import type React from 'react';
import { useMemo, useState } from 'react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { COMMANDS, type Command } from '@/types/workflow';

type SlashCommandDefinition = {
  command: Command;
  description: string;
  hint: string;
  icon: typeof Wand2;
};

const COMMAND_METADATA: Record<
  Command,
  Omit<SlashCommandDefinition, 'command'>
> = {
  new: {
    description: 'Create and switch to a new session',
    hint: '/new',
    icon: Wand2,
  },
  compact: {
    description: 'Force context compaction',
    hint: '/compact',
    icon: Hash,
  },
  init: {
    description: 'Generate or update AGENTS.md for this repository',
    hint: '/init',
    icon: BookOpen,
  },
  help: {
    description: 'Show slash command help',
    hint: '/help',
    icon: Search,
  },
  stop: {
    description: 'Stop the current workflow run',
    hint: '/stop',
    icon: Square,
  },
  status: {
    description: 'Show conversation status',
    hint: '/status',
    icon: Play,
  },
  session: {
    description: 'Show or switch the bound session',
    hint: '/session <session-id>',
    icon: Hash,
  },
  approve: {
    description: 'Approve a pending tool call',
    hint: '/approve <toolCallId> [note]',
    icon: ThumbsUp,
  },
  reject: {
    description: 'Reject a pending tool call',
    hint: '/reject <toolCallId> [note]',
    icon: ThumbsDown,
  },
  decisions: {
    description: 'List pending decisions (L2 auth + questions)',
    hint: '/decisions',
    icon: Search,
  },
  model: {
    description: 'Show or switch the current model',
    hint: '/model <model-id>',
    icon: Hash,
  },
  config: {
    description: 'Show or set config values (whitelist)',
    hint: '/config <path> [value]',
    icon: Settings,
  },
  memory: {
    description: 'Search, list, or add memories',
    hint: '/memory <query|builtin|search|add>',
    icon: Database,
  },
  pair: {
    description: 'Pair your IM account with a code',
    hint: '/pair <code>',
    icon: KeyRound,
  },
};

export const SLASH_COMMANDS: SlashCommandDefinition[] = COMMANDS.map(
  (command) => ({
    command,
    ...COMMAND_METADATA[command],
  }),
);

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
  const match = useMemo(
    () => getSlashCommandMatch(value, cursor),
    [cursor, value],
  );
  const items = useMemo(() => {
    if (!match) {
      return [];
    }

    const query = match.query.toLowerCase();
    return SLASH_COMMANDS.filter(({ command }) => command.startsWith(query));
  }, [match]);

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
      <div className="border-b border-border/60 px-3 py-2">
        <p className="text-xs font-medium text-foreground">Commands</p>
        <p className="text-xs text-muted-foreground">
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
                  <span className="truncate text-sm font-medium">
                    /{item.command}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {item.hint}
                  </span>
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
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
  const match = useMemo(
    () => getSlashCommandMatch(value, cursor),
    [cursor, value],
  );
  const items = useMemo(() => {
    if (!match) {
      return [];
    }

    const query = match.query.toLowerCase();
    return SLASH_COMMANDS.filter(({ command }) => command.startsWith(query));
  }, [match]);
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
