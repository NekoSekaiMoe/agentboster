'use client';

import {
  type ChatRequestOptions,
  type DynamicToolUIPart,
  getToolName,
  isToolUIPart,
} from 'ai';
import cx from 'classnames';
import equal from 'fast-deep-equal';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { type ReactNode, memo, useState } from 'react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import type {
  WorkflowDataUIPart,
  WorkflowMessageUIPart,
  WorkflowUIMessage,
} from '@/types/workflow';
import {
  getWorkflowDataAgentName,
  isWorkflowMessageUIPart,
  isWorkflowStatusUIPart,
} from '@/types/workflow';
import {
  AttachmentList,
  type ComposerAttachment,
  filePartToComposerAttachment,
} from './attachments';
import { ChevronDownIcon, PencilEditIcon } from './icons';
import { Logo } from './logo';
import { Markdown } from './markdown';
import { MessageActions } from './message-actions';
import { MessageEditor } from './message-editor';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getTextFromParts(message: WorkflowUIMessage): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function getFileAttachments(message: WorkflowUIMessage): ComposerAttachment[] {
  return message.parts.flatMap((part) => {
    if (part.type !== 'file') {
      return [];
    }

    return [filePartToComposerAttachment(part)];
  });
}

function getFileAttachment(
  part: WorkflowUIMessage['parts'][number],
): ComposerAttachment | null {
  if (
    part.type !== 'file' ||
    typeof part.url !== 'string' ||
    typeof part.mediaType !== 'string'
  ) {
    return null;
  }

  const name =
    'filename' in part && typeof part.filename === 'string'
      ? part.filename
      : 'Attachment';

  return {
    id: `${name}-${part.url}`,
    name,
    mediaType: part.mediaType,
    url: part.url,
    size: 0,
  };
}

function getReasoningParts(
  message: WorkflowUIMessage,
): Array<{ text: string }> {
  return message.parts.flatMap((part) => {
    if (
      part.type !== 'reasoning' ||
      typeof part.text !== 'string' ||
      part.text.trim().length === 0
    ) {
      return [];
    }

    return [{ text: part.text }];
  });
}

function formatJSON(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatToolState(state: DynamicToolUIPart['state']): string {
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

function formatToolName(toolName: string): string {
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

function normalizeToolPart(
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

function formatWorkflowEventTitle(part: WorkflowMessageUIPart): string {
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

function getWorkflowEventTone(part: WorkflowMessageUIPart): {
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

function formatWorkflowDataBody(part: WorkflowDataUIPart): ReactNode {
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

function WorkflowDataTimeline({
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

function getToolDisplayTitle(part: DynamicToolUIPart): string {
  const title = part.title?.trim();
  return title && title.length > 0 ? title : formatToolName(part.toolName);
}

function getToolStateTone(state: DynamicToolUIPart['state']): {
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

function ToolDetailsSection({
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

function ToolDetailsPre({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto rounded-xl border border-border/60 bg-muted/40 p-3 text-xs leading-5 text-foreground/80">
      {typeof value === 'string' ? value : formatJSON(value)}
    </pre>
  );
}

function ReasoningTimeline({
  parts,
  isLast = true,
}: {
  parts: Array<{ text: string }>;
  isLast?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const [expandedReasoningParts, setExpandedReasoningParts] = useState<
    Record<number, boolean>
  >({});

  if (parts.length === 0) {
    return null;
  }

  const detailsTransition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.18, ease: [0.22, 1, 0.36, 1] };

  const tone = {
    badge:
      'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    card: '',
    dot: 'bg-amber-500',
  };

  return (
    <div className="space-y-0">
      {parts.map((part, index) => {
        const isExpanded = expandedReasoningParts[index] ?? false;
        const detailsId = `reasoning-details-${index}`;
        const isLastItem = isLast && index === parts.length - 1;

        return (
          <div
            key={`reasoning-${index + 1}`}
            className="grid grid-cols-[20px_minmax(0,1fr)] gap-3"
          >
            <div className="flex h-full flex-col items-center">
              <span
                className={cn(
                  'mt-4 size-2.5 rounded-full border-2 border-background shadow-sm',
                  tone.dot,
                )}
              />
              {!isLastItem ? (
                <span className="mt-2 w-px flex-1 bg-border/80" />
              ) : null}
            </div>

            <div className={cn(!isLastItem && 'pb-4')}>
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
                    setExpandedReasoningParts((current) => ({
                      ...current,
                      [index]: !isExpanded,
                    }));
                  }}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold leading-5 text-foreground">
                      Reasoning
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
                      <div className="border-t border-border/60 bg-muted/10 px-4 pb-4 pt-3">
                        <div className="text-sm leading-6 text-foreground/80 whitespace-pre-wrap break-words">
                          {part.text}
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

function ToolTimeline({ parts }: { parts: DynamicToolUIPart[] }) {
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

function WorkflowMessageTimeline({
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

function MessagePartsTimeline({ message }: { message: WorkflowUIMessage }) {
  const workflowAgentGroups = new Map<
    string,
    { firstIndex: number; parts: WorkflowDataUIPart[] }
  >();

  for (const [index, part] of message.parts.entries()) {
    if (!isWorkflowMessageUIPart(part) && !isWorkflowStatusUIPart(part)) {
      continue;
    }

    const agentName = getWorkflowDataAgentName(part);
    if (!agentName) {
      continue;
    }

    const existing = workflowAgentGroups.get(agentName);
    if (existing) {
      existing.parts.push(part);
      continue;
    }

    workflowAgentGroups.set(agentName, {
      firstIndex: index,
      parts: [part],
    });
  }

  return (
    <div className="mt-4 space-y-4">
      {message.parts.map((part, index) => {
        if (part.type === 'text') {
          if (!part.text) {
            return null;
          }

          return (
            <div
              key={`text-${message.id}-${index}`}
              className="rounded-2xl bg-background/90 p-4"
            >
              <Markdown>{part.text}</Markdown>
            </div>
          );
        }

        if (part.type === 'file') {
          const attachment = getFileAttachment(part);
          if (!attachment) {
            return null;
          }

          return (
            <div
              key={`file-${message.id}-${index}`}
              className="rounded-2xl bg-background/90 p-4"
            >
              <AttachmentList attachments={[attachment]} />
            </div>
          );
        }

        if (part.type === 'reasoning') {
          if (typeof part.text !== 'string' || part.text.trim().length === 0) {
            return null;
          }

          return (
            <div key={`reasoning-${message.id}-${index}`}>
              <ReasoningTimeline parts={[{ text: part.text }]} />
            </div>
          );
        }

        const toolPart = normalizeToolPart(part);
        if (toolPart) {
          return (
            <div key={`tool-${message.id}-${index}`}>
              <ToolTimeline parts={[toolPart]} />
            </div>
          );
        }

        if (isWorkflowMessageUIPart(part)) {
          const agentName = getWorkflowDataAgentName(part);
          if (agentName) {
            const workflowGroup = workflowAgentGroups.get(agentName);
            if (!workflowGroup || workflowGroup.firstIndex !== index) {
              return null;
            }

            return (
              <div key={`workflow-agent-${message.id}-${agentName}-${index}`}>
                <WorkflowDataTimeline
                  agentName={agentName}
                  parts={workflowGroup.parts}
                />
              </div>
            );
          }

          return (
            <div key={`workflow-${message.id}-${index}`}>
              <WorkflowMessageTimeline parts={[part]} />
            </div>
          );
        }

        if (isWorkflowStatusUIPart(part)) {
          const agentName = getWorkflowDataAgentName(part);
          if (!agentName) {
            return null;
          }

          const workflowGroup = workflowAgentGroups.get(agentName);
          if (!workflowGroup || workflowGroup.firstIndex !== index) {
            return null;
          }

          return (
            <div key={`workflow-agent-${message.id}-${agentName}-${index}`}>
              <WorkflowDataTimeline
                agentName={agentName}
                parts={workflowGroup.parts}
              />
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}

function AssistantMessageParts({
  message,
  onToolApproval,
}: {
  message: WorkflowUIMessage;
  onToolApproval?: (input: {
    toolCallId: string;
    toolName: string;
    action: 'approve' | 'reject';
    comment?: string;
  }) => Promise<void>;
}) {
  const reduceMotion = useReducedMotion();
  const [expandedReasoningParts, setExpandedReasoningParts] = useState<
    Record<string, boolean>
  >({});
  const [expandedToolCalls, setExpandedToolCalls] = useState<
    Record<string, boolean>
  >({});
  const [expandedWorkflowParts, setExpandedWorkflowParts] = useState<
    Record<string, boolean>
  >({});
  const [approvalDialog, setApprovalDialog] = useState<{
    toolCallId: string;
    toolName: string;
    action: 'approve' | 'reject';
  } | null>(null);
  const [approvalComment, setApprovalComment] = useState('');
  const [submittingApproval, setSubmittingApproval] = useState(false);

  const detailsTransition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.18, ease: [0.22, 1, 0.36, 1] };

  // Build a list of renderable parts with their index info
  const renderableParts = message.parts
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => {
      if (part.type === 'text') {
        return part.text && part.text.trim().length > 0;
      }
      if (part.type === 'file') {
        return typeof part.url === 'string' && part.url.length > 0;
      }
      if (part.type === 'reasoning') {
        return typeof part.text === 'string' && part.text.trim().length > 0;
      }
      if (normalizeToolPart(part)) {
        return true;
      }
      if (isWorkflowStatusUIPart(part)) {
        return Boolean(getWorkflowDataAgentName(part));
      }
      if (isWorkflowMessageUIPart(part)) {
        return true;
      }
      return false;
    });

  // Check if a part is a timeline type (reasoning, tool, workflow)
  const isTimelinePart = (part: WorkflowUIMessage['parts'][number]) => {
    return (
      part.type === 'reasoning' ||
      normalizeToolPart(part) !== null ||
      isWorkflowMessageUIPart(part) ||
      (isWorkflowStatusUIPart(part) && Boolean(getWorkflowDataAgentName(part)))
    );
  };

  const workflowAgentGroups = new Map<
    string,
    { firstIndex: number; parts: WorkflowDataUIPart[] }
  >();

  for (const { part, index } of renderableParts) {
    if (!isWorkflowMessageUIPart(part) && !isWorkflowStatusUIPart(part)) {
      continue;
    }

    const agentName = getWorkflowDataAgentName(part);
    if (!agentName) {
      continue;
    }

    const existing = workflowAgentGroups.get(agentName);
    if (existing) {
      existing.parts.push(part);
      continue;
    }

    workflowAgentGroups.set(agentName, {
      firstIndex: index,
      parts: [part],
    });
  }

  // Check if next renderable part is also a timeline part (for connector line)
  const hasNextTimelinePart = (currentIdx: number) => {
    const currentPos = renderableParts.findIndex((p) => p.index === currentIdx);
    if (currentPos < 0 || currentPos >= renderableParts.length - 1)
      return false;
    return isTimelinePart(renderableParts[currentPos + 1].part);
  };

  const openApprovalDialog = (input: {
    toolCallId: string;
    toolName: string;
    action: 'approve' | 'reject';
  }) => {
    setApprovalComment('');
    setApprovalDialog(input);
  };

  const closeApprovalDialog = () => {
    if (submittingApproval) {
      return;
    }

    setApprovalDialog(null);
    setApprovalComment('');
  };

  const submitApproval = async () => {
    if (!approvalDialog || !onToolApproval) {
      return;
    }

    setSubmittingApproval(true);
    try {
      await onToolApproval({
        toolCallId: approvalDialog.toolCallId,
        toolName: approvalDialog.toolName,
        action: approvalDialog.action,
        comment: approvalComment.trim() || undefined,
      });

      toast.success(
        approvalDialog.action === 'approve'
          ? 'Approval submitted.'
          : 'Rejection submitted.',
      );
      setApprovalDialog(null);
      setApprovalComment('');
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to submit approval.',
      );
    } finally {
      setSubmittingApproval(false);
    }
  };

  return (
    <>
      <div className="flex min-w-0 flex-col gap-2 w-full">
        {renderableParts.map(({ part, index }) => {
          const showConnector = hasNextTimelinePart(index);

          if (part.type === 'text') {
            return (
              <div
                key={`text-${message.id}-${index}`}
                className="min-w-0 break-words"
              >
                <Markdown>{part.text}</Markdown>
              </div>
            );
          }

          if (part.type === 'file') {
            const attachment = getFileAttachment(part);
            if (!attachment) return null;
            return (
              <div key={`file-${message.id}-${index}`}>
                <AttachmentList attachments={[attachment]} />
              </div>
            );
          }

          if (part.type === 'reasoning' && typeof part.text === 'string') {
            const reasoningId = `reasoning-${message.id}-${index}`;
            const isExpanded = expandedReasoningParts[reasoningId] ?? false;
            const tone = {
              badge:
                'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
              card: '',
              dot: 'bg-amber-500',
            };

            return (
              <div
                key={reasoningId}
                className="grid grid-cols-[20px_minmax(0,1fr)] gap-3"
              >
                <div className="flex h-full flex-col items-center">
                  <span
                    className={cn(
                      'mt-4 size-2.5 rounded-full border-2 border-background shadow-sm',
                      tone.dot,
                    )}
                  />
                  {showConnector ? (
                    <span className="mt-2 w-px flex-1 bg-border/80" />
                  ) : null}
                </div>

                <div className={cn(showConnector && 'pb-4')}>
                  <div
                    className={cn(
                      'overflow-hidden rounded-[1.25rem] border border-border/70 bg-background/90 shadow-sm',
                      tone.card,
                    )}
                  >
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      aria-controls={`${reasoningId}-details`}
                      onClick={() => {
                        setExpandedReasoningParts((current) => ({
                          ...current,
                          [reasoningId]: !isExpanded,
                        }));
                      }}
                      className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold leading-5 text-foreground">
                          Reasoning
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
                          id={`${reasoningId}-details`}
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
                            <div className="text-sm leading-6 text-foreground/80 whitespace-pre-wrap break-words">
                              {part.text}
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

          const toolPart = normalizeToolPart(part);
          if (toolPart) {
            const tone = getToolStateTone(toolPart.state);
            const displayTitle = getToolDisplayTitle(toolPart);
            const detailsId = `tool-details-${toolPart.toolCallId}-${index}`;
            const isExpanded = expandedToolCalls[toolPart.toolCallId] ?? false;
            const showRawToolName =
              typeof toolPart.title === 'string' &&
              toolPart.title.trim().length > 0 &&
              toolPart.title.trim() !== toolPart.toolName;
            const hasInput =
              'input' in toolPart && toolPart.input !== undefined;
            const hasOutput = toolPart.state === 'output-available';
            const hasApproval =
              'approval' in toolPart && toolPart.approval !== undefined;
            const hasError = toolPart.state === 'output-error';
            const hasDetails = hasInput || hasOutput || hasApproval || hasError;
            const canRespondApproval =
              toolPart.state === 'approval-requested' &&
              Boolean(onToolApproval);

            return (
              <div
                key={`${toolPart.toolCallId}-${toolPart.state}-${index}`}
                className="grid grid-cols-[20px_minmax(0,1fr)] gap-3"
              >
                <div className="flex h-full flex-col items-center">
                  <span
                    className={cn(
                      'mt-4 size-2.5 rounded-full border-2 border-background shadow-sm',
                      tone.dot,
                      toolPart.state === 'input-streaming' &&
                        'animate-pulse motion-reduce:animate-none',
                    )}
                  />
                  {showConnector ? (
                    <span className="mt-2 w-px flex-1 bg-border/80" />
                  ) : null}
                </div>

                <div className={cn(showConnector && 'pb-4')}>
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
                          [toolPart.toolCallId]: !isExpanded,
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
                            {toolPart.toolName}
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
                          {formatToolState(toolPart.state)}
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

                    {canRespondApproval ? (
                      <div className="border-t border-border/60 bg-background/60 px-4 py-3">
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            size="sm"
                            type="button"
                            variant="outline"
                            onClick={() => {
                              openApprovalDialog({
                                toolCallId: toolPart.toolCallId,
                                toolName: toolPart.toolName,
                                action: 'reject',
                              });
                            }}
                          >
                            Reject
                          </Button>
                          <Button
                            size="sm"
                            type="button"
                            onClick={() => {
                              openApprovalDialog({
                                toolCallId: toolPart.toolCallId,
                                toolName: toolPart.toolName,
                                action: 'approve',
                              });
                            }}
                          >
                            Approve
                          </Button>
                        </div>
                      </div>
                    ) : null}

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
                                  <ToolDetailsPre value={toolPart.input} />
                                </ToolDetailsSection>
                              ) : null}

                              {hasOutput ? (
                                <ToolDetailsSection label="Output">
                                  <ToolDetailsPre value={toolPart.output} />
                                </ToolDetailsSection>
                              ) : null}

                              {hasApproval ? (
                                <ToolDetailsSection label="Approval">
                                  <ToolDetailsPre value={toolPart.approval} />
                                </ToolDetailsSection>
                              ) : null}

                              {hasError ? (
                                <ToolDetailsSection label="Error">
                                  <ToolDetailsPre value={toolPart.errorText} />
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
          }

          if (isWorkflowMessageUIPart(part)) {
            const agentName = getWorkflowDataAgentName(part);
            if (agentName) {
              const workflowGroup = workflowAgentGroups.get(agentName);
              if (!workflowGroup || workflowGroup.firstIndex !== index) {
                return null;
              }

              return (
                <div key={`workflow-agent-${message.id}-${agentName}-${index}`}>
                  <WorkflowDataTimeline
                    agentName={agentName}
                    parts={workflowGroup.parts}
                  />
                </div>
              );
            }

            const tone = getWorkflowEventTone(part);
            const workflowId = `${part.data.type}-${part.data.eventType}-${index}`;
            const isExpanded = expandedWorkflowParts[workflowId] ?? false;

            return (
              <div
                key={workflowId}
                className="grid grid-cols-[20px_minmax(0,1fr)] gap-3"
              >
                <div className="flex h-full flex-col items-center">
                  <span
                    className={cn(
                      'mt-4 size-2.5 rounded-full border-2 border-background shadow-sm',
                      tone.dot,
                    )}
                  />
                  {showConnector ? (
                    <span className="mt-2 w-px flex-1 bg-border/80" />
                  ) : null}
                </div>

                <div className={cn(showConnector && 'pb-4')}>
                  <div
                    className={cn(
                      'overflow-hidden rounded-[1.25rem] border border-border/70 bg-background/90 shadow-sm',
                      tone.card,
                    )}
                  >
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      aria-controls={`${workflowId}-details`}
                      onClick={() => {
                        setExpandedWorkflowParts((current) => ({
                          ...current,
                          [workflowId]: !isExpanded,
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
                          id={`${workflowId}-details`}
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
          }

          if (isWorkflowStatusUIPart(part)) {
            const agentName = getWorkflowDataAgentName(part);
            if (!agentName) {
              return null;
            }

            const workflowGroup = workflowAgentGroups.get(agentName);
            if (!workflowGroup || workflowGroup.firstIndex !== index) {
              return null;
            }

            return (
              <div key={`workflow-agent-${message.id}-${agentName}-${index}`}>
                <WorkflowDataTimeline
                  agentName={agentName}
                  parts={workflowGroup.parts}
                />
              </div>
            );
          }

          return null;
        })}
      </div>

      <AlertDialog
        open={approvalDialog !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            closeApprovalDialog();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {approvalDialog?.action === 'approve'
                ? 'Approve Tool Call'
                : 'Reject Tool Call'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {approvalDialog?.action === 'approve'
                ? 'Add an optional note before approving this action.'
                : 'Add an optional reason before rejecting this action.'}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <Textarea
            value={approvalComment}
            onChange={(event) => {
              setApprovalComment(event.target.value);
            }}
            placeholder="Optional note"
            maxLength={500}
          />

          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeApprovalDialog}
              disabled={submittingApproval}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={
                approvalDialog?.action === 'reject' ? 'outline' : 'default'
              }
              onClick={() => {
                void submitApproval();
              }}
              disabled={submittingApproval}
            >
              {submittingApproval
                ? 'Submitting...'
                : approvalDialog?.action === 'approve'
                  ? 'Confirm Approve'
                  : 'Confirm Reject'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const PurePreviewMessage = ({
  chatId,
  message,
  isLoading,
  onToolApproval,
  onRevert,
  setMessages,
  regenerate,
}: {
  chatId: string;
  message: WorkflowUIMessage;
  isLoading: boolean;
  onToolApproval?: (input: {
    toolCallId: string;
    toolName: string;
    action: 'approve' | 'reject';
    comment?: string;
  }) => Promise<void>;
  onRevert?: (messageId: string) => void;
  setMessages: (
    messages:
      | WorkflowUIMessage[]
      | ((messages: WorkflowUIMessage[]) => WorkflowUIMessage[]),
  ) => void;
  regenerate: (
    options?: { messageId?: string } & ChatRequestOptions,
  ) => Promise<void>;
}) => {
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const textContent = getTextFromParts(message);
  const attachments = getFileAttachments(message);
  const hasRenderableContent = textContent || attachments.length > 0;

  return (
    <AnimatePresence>
      <motion.div
        className="group/message mx-auto w-full max-w-full px-3 sm:max-w-3xl sm:px-4"
        initial={{ y: 5, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        data-role={message.role}
      >
        <div
          className={cn(
            'flex min-w-0 w-full max-w-full gap-4 group-data-[role=user]/message:ml-auto group-data-[role=user]/message:max-w-full sm:group-data-[role=user]/message:max-w-2xl',
            {
              'w-full': mode === 'edit',
              'group-data-[role=user]/message:w-full sm:group-data-[role=user]/message:w-fit':
                mode !== 'edit',
            },
          )}
        >
          {message.role === 'assistant' && (
            <div className="size-8 flex items-center rounded-full justify-center ring-1 shrink-0 ring-border bg-background">
              <div className="translate-y-px">
                <Logo />
              </div>
            </div>
          )}

          <div className="flex min-w-0 flex-col gap-2 w-full">
            {message.role === 'user' &&
              hasRenderableContent &&
              mode === 'view' && (
                <div className="flex flex-row gap-2 items-start">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        className="px-2 h-fit rounded-full text-muted-foreground opacity-0 group-hover/message:opacity-100"
                        onClick={() => {
                          setMode('edit');
                        }}
                      >
                        <PencilEditIcon />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Edit message</TooltipContent>
                  </Tooltip>

                  <div className="flex min-w-0 max-w-full flex-col gap-4 overflow-hidden rounded-xl bg-primary px-3 py-2 text-primary-foreground">
                    <AttachmentList attachments={attachments} />
                    {textContent ? (
                      <div className="min-w-0 break-words">
                        <Markdown>{textContent}</Markdown>
                      </div>
                    ) : null}
                  </div>
                </div>
              )}

            {message.role === 'user' &&
              hasRenderableContent &&
              mode === 'edit' && (
                <div className="flex flex-row gap-2 items-start">
                  <div className="size-8" />

                  <MessageEditor
                    key={message.id}
                    message={message}
                    setMode={setMode}
                    setMessages={setMessages}
                    regenerate={regenerate}
                  />
                </div>
              )}

            {message.role === 'assistant' && (
              <AssistantMessageParts
                message={message}
                onToolApproval={onToolApproval}
              />
            )}

            <MessageActions
              key={`action-${message.id}`}
              chatId={chatId}
              message={message}
              isLoading={isLoading}
              onRevert={onRevert}
            />
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
};

export const PreviewMessage = memo(
  PurePreviewMessage,
  (prevProps, nextProps) => {
    if (prevProps.chatId !== nextProps.chatId) return false;
    if (prevProps.isLoading !== nextProps.isLoading) return false;
    if (prevProps.message.id !== nextProps.message.id) return false;
    if (prevProps.message.role !== nextProps.message.role) return false;
    if (prevProps.onToolApproval !== nextProps.onToolApproval) return false;
    if (!equal(prevProps.message.parts, nextProps.message.parts)) return false;
    if (!equal(prevProps.message.metadata, nextProps.message.metadata)) {
      return false;
    }

    return true;
  },
);

export const ThinkingMessage = () => {
  const role = 'assistant';

  return (
    <motion.div
      className="group/message mx-auto w-full max-w-full px-3 sm:max-w-3xl sm:px-4"
      initial={{ y: 5, opacity: 0 }}
      animate={{ y: 0, opacity: 1, transition: { delay: 1 } }}
      data-role={role}
    >
      <div
        className={cx(
          'flex min-w-0 gap-4 group-data-[role=user]/message:px-3 w-full group-data-[role=user]/message:w-fit group-data-[role=user]/message:ml-auto group-data-[role=user]/message:max-w-2xl group-data-[role=user]/message:py-2 rounded-xl',
          {
            'group-data-[role=user]/message:bg-muted': true,
          },
        )}
      >
        <div className="size-8 flex items-center rounded-full justify-center ring-1 shrink-0 ring-border">
          <Logo />
        </div>

        <div className="flex min-w-0 flex-col gap-2 w-full">
          <div className="flex flex-col gap-4 text-muted-foreground">
            Thinking...
          </div>
        </div>
      </div>
    </motion.div>
  );
};
