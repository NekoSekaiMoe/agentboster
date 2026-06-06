'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronRight, Sparkles } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';
import type {
  WorkflowDataUIPart,
  WorkflowMessageUIPart,
} from '@/types/workflow';
import { isWorkflowMessageUIPart } from '@/types/workflow';
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
      <div className="whitespace-pre-wrap break-words text-foreground/80 text-sm leading-6">
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
        <div className="whitespace-pre-wrap break-words text-foreground/80 text-sm leading-6">
          {part.data.content}
        </div>
      );
    default:
      return null;
  }
}

function WorkflowSummaryButton({
  label,
  detailsId,
  isExpanded,
  onToggle,
}: {
  label: string;
  detailsId: string;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={isExpanded}
      aria-controls={detailsId}
      onClick={onToggle}
      className="-mx-1 inline-flex max-w-full cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left text-foreground/70 text-sm leading-6 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <Sparkles className="size-3.5 shrink-0 text-[#6d9ec3]" />
      <span className="min-w-0 truncate">{label}</span>
      <ChevronRight
        className={cn(
          'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none',
          isExpanded && 'rotate-90',
        )}
      />
    </button>
  );
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
  const detailsId = `workflow-agent-${agentName}`;
  const detailsTransition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.18, ease: [0.22, 1, 0.36, 1] };

  if (parts.length === 0) {
    return null;
  }

  const label =
    parts.length === 1
      ? `${agentName}: ${formatWorkflowDataTitle(parts[0])}`
      : `${agentName}: ${parts.length} workflow events`;

  return (
    <div className="min-w-0">
      <WorkflowSummaryButton
        label={label}
        detailsId={detailsId}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded((current) => !current)}
      />

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
            <div className="mt-2 ml-6 rounded-lg border border-border/50 bg-muted/20 px-3 py-3">
              <div className="space-y-3">
                {parts.map((part, index) => (
                  <div key={`${agentName}-${part.type}-${index}`}>
                    <div className="text-[11px] text-muted-foreground uppercase tracking-[0.16em]">
                      {formatWorkflowDataTitle(part)}
                    </div>
                    <div className="mt-2">{formatWorkflowDataBody(part)}</div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
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
    <div className="space-y-2">
      {parts.map((part, index) => {
        const key = `${part.data.type}-${part.data.eventType}-${index}`;
        const detailsId = `workflow-details-${key}`;
        const isExpanded = expandedWorkflowParts[key] ?? false;

        return (
          <div key={key} className="min-w-0">
            <WorkflowSummaryButton
              label={`Workflow ${formatWorkflowEventTitle(part)}`}
              detailsId={detailsId}
              isExpanded={isExpanded}
              onToggle={() => {
                setExpandedWorkflowParts((current) => ({
                  ...current,
                  [key]: !isExpanded,
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
                    <div className="whitespace-pre-wrap break-words text-foreground/80 text-sm leading-6">
                      {part.data.message}
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
