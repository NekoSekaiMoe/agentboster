'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useState } from 'react';

import { cn } from '@/lib/utils';
import type {
  WorkflowDataUIPart,
  WorkflowMessageUIPart,
} from '@/types/workflow';
import { isWorkflowMessageUIPart } from '@/types/workflow';
import { ChevronDownIcon } from './icons';
import { ToolDetailsPre, formatToolName } from './tool-timeline';

export function formatWorkflowEventTitle(part: WorkflowMessageUIPart): string {
  if (part.data.type !== 'system-event') {
    return 'Workflow Event';
  }

  switch (part.data.eventType) {
    case 'compact':
      return 'Context Compacted';
    case 'error':
      return 'Workflow Error';
    default:
      return formatToolName(part.data.eventType);
  }
}

export function getWorkflowEventTone(part: WorkflowMessageUIPart): {
  badge: string;
  card: string;
  dot: string;
} {
  if (part.data.type !== 'system-event') {
    return {
      badge:
        'border-slate-500/25 bg-slate-500/10 text-slate-700 dark:text-slate-300',
      card: '',
      dot: 'bg-slate-500',
    };
  }

  switch (part.data.eventType) {
    case 'error':
      return {
        badge:
          'border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300',
        card: 'border-l-[3px] border-l-rose-500/70',
        dot: 'bg-rose-500',
      };
    case 'compact':
      return {
        badge: 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300',
        card: 'border-l-[3px] border-l-sky-500/70',
        dot: 'bg-sky-500',
      };
    default:
      return {
        badge:
          'border-slate-500/25 bg-slate-500/10 text-slate-700 dark:text-slate-300',
        card: '',
        dot: 'bg-slate-500',
      };
  }
}

function getWorkflowDataTone(part: WorkflowDataUIPart): {
  badge: string;
  card: string;
  dot: string;
} {
  if (isWorkflowMessageUIPart(part)) {
    return getWorkflowEventTone(part);
  }

  switch (part.data.type) {
    case 'runtime-event':
      return {
        badge:
          'border-slate-500/25 bg-slate-500/10 text-slate-700 dark:text-slate-300',
        card: '',
        dot: 'bg-slate-500',
      };
    case 'token-usage':
      return {
        badge: 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300',
        card: '',
        dot: 'bg-sky-500',
      };
    case 'step-finish':
      return {
        badge:
          'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
        card: '',
        dot: 'bg-emerald-500',
      };
    case 'user-message':
      return {
        badge:
          'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
        card: '',
        dot: 'bg-amber-500',
      };
    default:
      return {
        badge:
          'border-slate-500/25 bg-slate-500/10 text-slate-700 dark:text-slate-300',
        card: '',
        dot: 'bg-slate-500',
      };
  }
}

function formatWorkflowDataTitle(part: WorkflowDataUIPart): string {
  if (isWorkflowMessageUIPart(part)) {
    return formatWorkflowEventTitle(part);
  }

  switch (part.data.type) {
    case 'runtime-event':
      return formatToolName(part.data.payload.event);
    case 'token-usage':
      return 'Token Usage';
    case 'step-finish':
      return `Step ${part.data.stepNumber} Finished`;
    case 'user-message':
      return 'User Message';
    default:
      return 'Workflow Event';
  }
}

function formatWorkflowDataBody(part: WorkflowDataUIPart): React.ReactNode {
  if (part.data.kind === 'message') {
    return (
      <div className="text-sm leading-6 text-foreground/80 whitespace-pre-wrap break-words">
        {part.data.message}
      </div>
    );
  }

  switch (part.data.type) {
    case 'runtime-event':
      return <ToolDetailsPre value={part.data.payload} />;
    case 'token-usage':
      return <ToolDetailsPre value={part.data.usage} />;
    case 'step-finish':
      return (
        <ToolDetailsPre
          value={{
            stepNumber: part.data.stepNumber,
            finishReason: part.data.finishReason,
            totalTokens: part.data.totalTokens,
            inputTokens: part.data.inputTokens,
            outputTokens: part.data.outputTokens,
            messageIds: part.data.messageIds,
          }}
        />
      );
    case 'user-message':
      return (
        <div className="text-sm leading-6 text-foreground/80 whitespace-pre-wrap break-words">
          {part.data.content}
        </div>
      );
    default:
      return null;
  }
}

export function WorkflowDataTimeline({
  agentName,
  parts,
}: {
  agentName: string;
  parts: WorkflowDataUIPart[];
}) {
  const reduceMotion = useReducedMotion();
  const [isExpanded, setIsExpanded] = useState(false);
  const tone = getWorkflowDataTone(parts[0]);
  const detailsId = `workflow-agent-${agentName}`;
  const detailsTransition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.18, ease: [0.22, 1, 0.36, 1] };

  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-3">
      <div className="flex h-full flex-col items-center">
        <span
          className={cn(
            'mt-4 size-2.5 rounded-full border-2 border-background shadow-sm',
            tone.dot,
          )}
        />
        <span className="mt-2 w-px flex-1 bg-border/80" />
      </div>

      <div className="pb-4">
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
              setIsExpanded((current) => !current);
            }}
            className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                {agentName}:
              </div>
              <div className="mt-1 text-sm font-semibold leading-5 text-foreground">
                Workflow
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2 pl-2">
              <span
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em]',
                  tone.badge,
                )}
              >
                {isExpanded ? 'Expanded' : 'Collapsed'}
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
                initial={{ height: 0, opacity: 0, y: reduceMotion ? 0 : -4 }}
                animate={{ height: 'auto', opacity: 1, y: 0 }}
                exit={{ height: 0, opacity: 0, y: reduceMotion ? 0 : -4 }}
                transition={detailsTransition}
                className="overflow-hidden"
              >
                <div className="border-t border-border/60 px-4 pb-4 pt-3">
                  <div className="space-y-3">
                    {parts.map((part, index) => (
                      <div
                        key={`${agentName}-${part.type}-${index}`}
                        className="rounded-xl border border-border/60 bg-muted/10 p-3"
                      >
                        <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                          {formatWorkflowDataTitle(part)}
                        </div>
                        <div className="mt-2">
                          {formatWorkflowDataBody(part)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

export function WorkflowMessageTimeline({
  parts,
}: {
  parts: WorkflowMessageUIPart[];
}) {
  const reduceMotion = useReducedMotion();
  const [expandedWorkflowParts, setExpandedWorkflowParts] = useState<
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
        const tone = getWorkflowEventTone(part);
        const detailsId = `workflow-details-${part.data.type}-${part.data.eventType}-${index}`;
        const isExpanded =
          expandedWorkflowParts[
            `${part.data.type}-${part.data.eventType}-${index}`
          ] ?? false;

        return (
          <div
            key={`${part.data.type}-${part.data.eventType}-${index}`}
            className="grid grid-cols-[20px_minmax(0,1fr)] gap-3"
          >
            <div className="flex h-full flex-col items-center">
              <span
                className={cn(
                  'mt-4 size-2.5 rounded-full border-2 border-background shadow-sm',
                  tone.dot,
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
                    setExpandedWorkflowParts((current) => ({
                      ...current,
                      [`${part.data.type}-${part.data.eventType}-${index}`]:
                        !isExpanded,
                    }));
                  }}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold leading-5 text-foreground">
                      {formatWorkflowEventTitle(part)}
                    </div>
                    <div className="mt-1 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                      Workflow
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2 pl-2">
                    <span
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em]',
                        tone.badge,
                      )}
                    >
                      {isExpanded ? 'Expanded' : 'Collapsed'}
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
                      <div className="border-t border-border/60 px-4 pb-4 pt-3">
                        {part.data.type === 'system-event' ? (
                          <div className="text-sm leading-6 text-foreground/80 whitespace-pre-wrap break-words">
                            {part.data.message}
                          </div>
                        ) : null}
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
