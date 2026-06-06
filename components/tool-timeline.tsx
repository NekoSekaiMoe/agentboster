'use client';

import { type DynamicToolUIPart, getToolName, isToolUIPart } from 'ai';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  BookOpen,
  ChevronRight,
  Code2,
  Globe,
  Terminal,
  Wrench,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { cn } from '@/lib/utils';
import type { WorkflowUIMessage } from '@/types/workflow';

export function formatJSON(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

function getToolActionText(state: DynamicToolUIPart['state']): string {
  switch (state) {
    case 'input-streaming':
      return '正在使用';
    case 'input-available':
      return '已使用';
    case 'approval-requested':
      return '等待批准';
    case 'approval-responded':
      return '已批准';
    case 'output-error':
      return '工具失败';
    case 'output-denied':
      return '已拒绝';
    case 'output-available':
    default:
      return '已使用';
  }
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return '';
  }

  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)}ms`;
  }

  const seconds = milliseconds / 1000;
  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`;
  }

  return `${Math.round(seconds)}s`;
}

function readDurationCandidate(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  if (typeof value === 'number') {
    return formatDuration(value > 60 ? value : value * 1000);
  }

  return '';
}

function getToolDurationText(part: DynamicToolUIPart): string {
  const containers: unknown[] = [part];

  if ('callProviderMetadata' in part) {
    containers.push(part.callProviderMetadata);
  }

  if ('output' in part) {
    containers.push(part.output);
  }

  for (const container of containers) {
    if (!isRecord(container)) {
      continue;
    }

    for (const key of [
      'durationText',
      'duration',
      'durationMs',
      'duration_ms',
      'elapsedMs',
      'elapsed_ms',
    ]) {
      const formatted = readDurationCandidate(container[key]);
      if (formatted) {
        return formatted;
      }
    }
  }

  return '';
}

function ToolCallIcon({ toolName }: { toolName: string }) {
  const normalized = toolName.toLowerCase();

  if (normalized.includes('python') || normalized.includes('code')) {
    return <Code2 className="size-3.5 shrink-0 text-foreground/80" />;
  }

  if (normalized.includes('search') || normalized.includes('web')) {
    return <Globe className="size-3.5 shrink-0 text-foreground/80" />;
  }

  if (normalized.includes('shell') || normalized.includes('terminal')) {
    return <Terminal className="size-3.5 shrink-0 text-foreground/80" />;
  }

  if (normalized.includes('memory')) {
    return <BookOpen className="size-3.5 shrink-0 text-foreground/80" />;
  }

  return <Wrench className="size-3.5 shrink-0 text-foreground/80" />;
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
      <div className="text-[11px] text-muted-foreground uppercase tracking-[0.16em]">
        {label}
      </div>
      {children}
    </div>
  );
}

export function ToolDetailsPre({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto rounded-xl border border-border/60 bg-muted/40 p-3 text-foreground/80 text-xs leading-5">
      {typeof value === 'string' ? value : formatJSON(value)}
    </pre>
  );
}

export function ToolCallSummaryButton({
  part,
  detailsId,
  isExpanded,
  onToggle,
}: {
  part: DynamicToolUIPart;
  detailsId: string;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const displayTitle = getToolDisplayTitle(part);
  const summary = `${getToolActionText(part.state)} ${displayTitle} 工具`;
  const duration = getToolDurationText(part);
  const fullTitle =
    displayTitle === part.toolName
      ? displayTitle
      : `${displayTitle} (${part.toolName})`;

  return (
    <button
      type="button"
      aria-expanded={isExpanded}
      aria-controls={detailsId}
      onClick={onToggle}
      title={fullTitle}
      className="-mx-1 inline-flex max-w-full cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left text-foreground/75 text-sm leading-6 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <ToolCallIcon toolName={part.toolName} />
      <span className="min-w-0 truncate">{summary}</span>
      {duration ? (
        <span className="shrink-0 text-muted-foreground/70">{duration}</span>
      ) : null}
      <ChevronRight
        className={cn(
          'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none',
          isExpanded && 'rotate-90',
        )}
      />
    </button>
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
    <div className="space-y-2">
      {parts.map((part, index) => {
        const detailsId = `tool-details-${part.toolCallId}-${index}`;
        const isExpanded = expandedToolCalls[part.toolCallId] ?? false;
        const hasInput = 'input' in part && part.input !== undefined;
        const hasOutput = part.state === 'output-available';
        const hasApproval = 'approval' in part && part.approval !== undefined;
        const hasError = part.state === 'output-error';
        const hasDetails = hasInput || hasOutput || hasApproval || hasError;

        return (
          <div
            key={`${part.toolCallId}-${part.state}-${index}`}
            className="min-w-0"
          >
            <ToolCallSummaryButton
              part={part}
              detailsId={detailsId}
              isExpanded={isExpanded}
              onToggle={() => {
                setExpandedToolCalls((current) => ({
                  ...current,
                  [part.toolCallId]: !isExpanded,
                }));
              }}
            />

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
                  <div className="mt-2 ml-6 rounded-lg border border-border/50 bg-muted/20 px-3 py-3">
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
                        <div className="rounded-lg border border-border/60 border-dashed bg-muted/30 p-3 text-muted-foreground text-xs">
                          Structured details are not available yet.
                        </div>
                      ) : null}
                    </div>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}
