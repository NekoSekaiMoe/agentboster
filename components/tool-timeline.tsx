'use client';

import { type DynamicToolUIPart, getToolName, isToolUIPart } from 'ai';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { type ReactNode, useState } from 'react';

import { cn } from '@/lib/utils';
import type { WorkflowUIMessage } from '@/types/workflow';
import { ChevronDownIcon } from './icons';

export function formatJSON(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatToolState(state: DynamicToolUIPart['state']): string {
  switch (state) {
    case 'input-available':
      return 'Called';
    case 'approval-requested':
      return 'Needs approval';
    case 'approval-responded':
      return 'Approval received';
    case 'output-available':
      return 'Result';
    case 'output-error':
      return 'Failed';
    case 'output-denied':
      return 'Denied';
    case 'input-streaming':
      return 'Preparing input';
    default:
      return state;
  }
}

export function formatToolName(toolName: string): string {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((segment) =>
      segment.length > 0
        ? `${segment[0].toUpperCase()}${segment.slice(1)}`
        : segment,
    )
    .join(' ');
}

export function normalizeToolPart(
  part: WorkflowUIMessage['parts'][number],
): DynamicToolUIPart | null {
  if (!isToolUIPart(part)) {
    return null;
  }

  if (part.type === 'dynamic-tool') {
    return part;
  }

  const shared = {
    type: 'dynamic-tool' as const,
    toolName: getToolName(part),
    toolCallId: part.toolCallId,
    providerExecuted: part.providerExecuted,
  };

  switch (part.state) {
    case 'input-streaming':
      return {
        ...shared,
        state: 'input-streaming',
        input: part.input,
        callProviderMetadata: part.callProviderMetadata,
      };
    case 'input-available':
      return {
        ...shared,
        state: 'input-available',
        input: part.input,
        callProviderMetadata: part.callProviderMetadata,
      };
    case 'approval-requested':
      return {
        ...shared,
        state: 'approval-requested',
        input: part.input,
        approval: part.approval,
        callProviderMetadata: part.callProviderMetadata,
      };
    case 'approval-responded':
      return {
        ...shared,
        state: 'approval-responded',
        input: part.input,
        approval: part.approval,
        callProviderMetadata: part.callProviderMetadata,
      };
    case 'output-available':
      return {
        ...shared,
        state: 'output-available',
        input: part.input,
        output: part.output,
        approval: part.approval,
        preliminary: part.preliminary,
        callProviderMetadata: part.callProviderMetadata,
      };
    case 'output-error':
      return {
        ...shared,
        state: 'output-error',
        input: part.input,
        errorText: part.errorText,
        approval: part.approval,
        callProviderMetadata: part.callProviderMetadata,
      };
    case 'output-denied':
      return {
        ...shared,
        state: 'output-denied',
        input: part.input,
        approval: part.approval,
        callProviderMetadata: part.callProviderMetadata,
      };
    default:
      return null;
  }
}

export function getToolDisplayTitle(part: DynamicToolUIPart): string {
  const title = part.title?.trim();
  return title && title.length > 0 ? title : formatToolName(part.toolName);
}

export function getToolStateTone(state: DynamicToolUIPart['state']): {
  badge: string;
  card: string;
  dot: string;
} {
  switch (state) {
    case 'output-available':
      return {
        badge:
          'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
        card: '',
        dot: 'bg-emerald-500',
      };
    case 'output-error':
      return {
        badge:
          'border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300',
        card: '',
        dot: 'bg-rose-500',
      };
    case 'approval-requested':
      return {
        badge:
          'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
        card: 'border-l-[3px] border-l-amber-500/70',
        dot: 'bg-amber-500',
      };
    case 'approval-responded':
      return {
        badge: 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300',
        card: '',
        dot: 'bg-sky-500',
      };
    case 'output-denied':
      return {
        badge:
          'border-zinc-500/25 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
        card: '',
        dot: 'bg-zinc-500',
      };
    case 'input-streaming':
      return {
        badge:
          'border-indigo-500/25 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300',
        card: '',
        dot: 'bg-indigo-500',
      };
    case 'input-available':
    default:
      return {
        badge:
          'border-slate-500/25 bg-slate-500/10 text-slate-700 dark:text-slate-300',
        card: '',
        dot: 'bg-slate-500',
      };
  }
}

export function ToolDetailsSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

export function ToolDetailsPre({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto rounded-xl border border-border/60 bg-muted/40 p-3 text-xs leading-5 text-foreground/80">
      {typeof value === 'string' ? value : formatJSON(value)}
    </pre>
  );
}

export function ToolTimeline({ parts }: { parts: DynamicToolUIPart[] }) {
  const reduceMotion = useReducedMotion();
  const [expandedToolCalls, setExpandedToolCalls] = useState<
    Record<string, boolean>
  >({});

  if (parts.length === 0) {
    return null;
  }

  const detailsTransition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.18, ease: [0.22, 1, 0.36, 1] };

  return (
    <div className="space-y-0">
      {parts.map((part, index) => {
        const tone = getToolStateTone(part.state);
        const displayTitle = getToolDisplayTitle(part);
        const detailsId = `tool-details-${part.toolCallId}-${index}`;
        const isExpanded = expandedToolCalls[part.toolCallId] ?? false;
        const showRawToolName =
          typeof part.title === 'string' &&
          part.title.trim().length > 0 &&
          part.title.trim() !== part.toolName;
        const hasInput = 'input' in part && part.input !== undefined;
        const hasOutput = part.state === 'output-available';
        const hasApproval = 'approval' in part && part.approval !== undefined;
        const hasError = part.state === 'output-error';
        const hasDetails = hasInput || hasOutput || hasApproval || hasError;

        return (
          <div
            key={`${part.toolCallId}-${part.state}-${index}`}
            className="grid grid-cols-[20px_minmax(0,1fr)] gap-3"
          >
            <div className="flex h-full flex-col items-center">
              <span
                className={cn(
                  'mt-4 size-2.5 rounded-full border-2 border-background shadow-sm',
                  tone.dot,
                  part.state === 'input-streaming' &&
                    'animate-pulse motion-reduce:animate-none',
                )}
              />
              {index < parts.length - 1 ? (
                <span className="mt-2 w-px flex-1 bg-border/80" />
              ) : null}
            </div>

            <div className={cn(index < parts.length - 1 && 'pb-4')}>
              <div
                className={cn(
                  'overflow-hidden rounded-[1.25rem] border border-border/70 bg-background/90 shadow-sm',
                  tone.card,
                )}
              >
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  aria-controls={detailsId}
                  onClick={() => {
                    setExpandedToolCalls((current) => ({
                      ...current,
                      [part.toolCallId]: !isExpanded,
                    }));
                  }}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold leading-5 text-foreground">
                      {displayTitle}
                    </div>
                    {showRawToolName ? (
                      <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                        {part.toolName}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-2 pl-2">
                    <span
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em]',
                        tone.badge,
                      )}
                    >
                      {formatToolState(part.state)}
                    </span>
                    <span
                      className={cn(
                        'text-muted-foreground transition-transform duration-200 motion-reduce:transition-none',
                        isExpanded && 'rotate-180',
                      )}
                    >
                      <ChevronDownIcon size={14} />
                    </span>
                  </div>
                </button>

                <AnimatePresence initial={false}>
                  {isExpanded ? (
                    <motion.div
                      id={detailsId}
                      initial={{
                        height: 0,
                        opacity: 0,
                        y: reduceMotion ? 0 : -4,
                      }}
                      animate={{ height: 'auto', opacity: 1, y: 0 }}
                      exit={{
                        height: 0,
                        opacity: 0,
                        y: reduceMotion ? 0 : -4,
                      }}
                      transition={detailsTransition}
                      className="overflow-hidden"
                    >
                      <div className="border-t border-border/60 bg-muted/10 px-4 pb-4 pt-3">
                        <div className="space-y-3">
                          {hasInput ? (
                            <ToolDetailsSection label="Input">
                              <ToolDetailsPre value={part.input} />
                            </ToolDetailsSection>
                          ) : null}

                          {hasOutput ? (
                            <ToolDetailsSection label="Output">
                              <ToolDetailsPre value={part.output} />
                            </ToolDetailsSection>
                          ) : null}

                          {hasApproval ? (
                            <ToolDetailsSection label="Approval">
                              <ToolDetailsPre value={part.approval} />
                            </ToolDetailsSection>
                          ) : null}

                          {hasError ? (
                            <ToolDetailsSection label="Error">
                              <ToolDetailsPre value={part.errorText} />
                            </ToolDetailsSection>
                          ) : null}

                          {!hasDetails ? (
                            <div className="rounded-xl border border-dashed border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
                              Structured details are not available yet.
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
