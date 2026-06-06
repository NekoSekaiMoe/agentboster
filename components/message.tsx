'use client';

import { type ChatRequestOptions } from 'ai';
import equal from 'fast-deep-equal';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { memo, useState } from 'react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import type { WorkflowDataUIPart, WorkflowUIMessage } from '@/types/workflow';
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
  ToolDetailsPre,
  ToolDetailsSection,
  formatToolState,
  getToolDisplayTitle,
  getToolStateTone,
  normalizeToolPart,
} from './tool-timeline';
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
import {
  WorkflowDataTimeline,
  formatWorkflowEventTitle,
  getWorkflowEventTone,
} from './workflow-timeline';

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
      <div className='flex w-full min-w-0 flex-col gap-2'>
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
                      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    >
                      <div className="min-w-0 flex-1">
                        <div className='truncate font-semibold text-foreground text-sm leading-5'>
                          Reasoning
                        </div>
                      </div>

                      <span
                        className={cn(
                          'shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none',
                          isExpanded && 'rotate-180',
                        )}
                      >
                        <ChevronDownIcon size={14} />
                      </span>
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
                          <div className='border-border/60 border-t bg-muted/10 px-4 pt-3 pb-4'>
                            <div className='whitespace-pre-wrap break-words text-foreground/80 text-sm leading-6'>
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
                        <div className='font-semibold text-foreground text-sm leading-5'>
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
                            'rounded-full border px-2 py-0.5 font-medium text-[10px] uppercase tracking-[0.16em]',
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
                      <div className='border-border/60 border-t bg-background/60 px-4 py-3'>
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
                          <div className='border-border/60 border-t bg-muted/10 px-4 pt-3 pb-4'>
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
                                <div className='rounded-xl border border-border/60 border-dashed bg-muted/30 p-3 text-muted-foreground text-xs'>
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
                        <div className='font-semibold text-foreground text-sm leading-5'>
                          {formatWorkflowEventTitle(part)}
                        </div>
                        <div className='mt-1 text-[11px] text-muted-foreground uppercase tracking-[0.16em]'>
                          Workflow
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2 pl-2">
                        <span
                          className={cn(
                            'rounded-full border px-2 py-0.5 font-medium text-[10px] uppercase tracking-[0.16em]',
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
                          <div className='border-border/60 border-t px-4 pt-3 pb-4'>
                            {part.data.type === 'system-event' ? (
                              <div className='whitespace-pre-wrap break-words text-foreground/80 text-sm leading-6'>
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
            'flex w-full min-w-0 max-w-full gap-4 group-data-[role=user]/message:ml-auto group-data-[role=user]/message:max-w-full sm:group-data-[role=user]/message:max-w-2xl',
            {
              'w-full': mode === 'edit',
              'group-data-[role=user]/message:w-full sm:group-data-[role=user]/message:w-fit':
                mode !== 'edit',
            },
          )}
        >
          {message.role === 'assistant' && (
            <div className='flex size-8 shrink-0 items-center justify-center rounded-full bg-background ring-1 ring-border'>
              <div className="translate-y-px">
                <Logo />
              </div>
            </div>
          )}

          <div className='flex w-full min-w-0 flex-col gap-2'>
            {message.role === 'user' &&
              hasRenderableContent &&
              mode === 'view' && (
                <div className='flex flex-row items-start gap-2'>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        className='h-fit rounded-full px-2 text-muted-foreground opacity-0 group-hover/message:opacity-100'
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
                <div className='flex flex-row items-start gap-2'>
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
        className={cn(
          'flex w-full min-w-0 gap-4 rounded-xl group-data-[role=user]/message:ml-auto group-data-[role=user]/message:w-fit group-data-[role=user]/message:max-w-2xl group-data-[role=user]/message:px-3 group-data-[role=user]/message:py-2',
          {
            'group-data-[role=user]/message:bg-muted': true,
          },
        )}
      >
        <div className='flex size-8 shrink-0 items-center justify-center rounded-full ring-1 ring-border'>
          <Logo />
        </div>

        <div className='flex w-full min-w-0 flex-col gap-2'>
          <div className="flex flex-col gap-4 text-muted-foreground">
            Thinking...
          </div>
        </div>
      </div>
    </motion.div>
  );
};
