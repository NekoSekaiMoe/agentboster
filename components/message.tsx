'use client';

import { type ChatRequestOptions } from 'ai';
import equal from 'fast-deep-equal';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronRight, MessageSquareText, Sparkles } from 'lucide-react';
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
import { parseSuggestedFollowUps } from '@/lib/chat/suggested-follow-up';
import { PencilEditIcon } from './icons';
import { Logo } from './logo';
import { Markdown } from './markdown';
import { MessageActions } from './message-actions';
import { MessageEditor } from './message-editor';
import {
  ToolCallSummaryButton,
  ToolDetailsPre,
  ToolDetailsSection,
  formatToolName,
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
import { formatWorkflowEventTitle } from './workflow-timeline';

function _isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getTextFromParts(message: WorkflowUIMessage): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function SuggestedFollowUpButtons({
  questions,
  onSelect,
}: {
  questions: string[];
  onSelect?: (question: string) => void;
}) {
  if (!onSelect) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {questions.map((question) => (
        <Button
          key={question}
          type="button"
          size="sm"
          variant="outline"
          className="h-auto min-h-9 max-w-full justify-start rounded-md px-3 py-2 text-left font-normal text-sm leading-5"
          onClick={() => onSelect(question)}
        >
          <MessageSquareText className="size-4 shrink-0 text-[#6d9ec3]" />
          <span className="min-w-0 break-words">{question}</span>
        </Button>
      ))}
    </div>
  );
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

function AssistantGlyph() {
  return (
    <div className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-background ring-1 ring-border/70">
      <Logo width={22} height={22} />
    </div>
  );
}

function WorkflowSummaryButton({
  part,
  detailsId,
  isExpanded,
  onToggle,
}: {
  part: WorkflowDataUIPart;
  detailsId: string;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const agentName = getWorkflowDataAgentName(part);
  const title = isWorkflowMessageUIPart(part)
    ? formatWorkflowEventTitle(part)
    : formatWorkflowStatusTitle(part);
  const summary = agentName ? `${agentName}: ${title}` : title;

  return (
    <button
      type="button"
      aria-expanded={isExpanded}
      aria-controls={detailsId}
      onClick={onToggle}
      className="-mx-1 inline-flex max-w-full cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left text-foreground/70 text-sm leading-6 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <Sparkles className="size-3.5 shrink-0 text-[#6d9ec3]" />
      <span className="min-w-0 truncate">Workflow {summary}</span>
      <ChevronRight
        className={cn(
          'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none',
          isExpanded && 'rotate-90',
        )}
      />
    </button>
  );
}

function formatWorkflowStatusTitle(part: WorkflowDataUIPart): string {
  if (part.data.kind !== 'status') {
    return 'Workflow';
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
      return 'Workflow';
  }
}

function WorkflowDetails({ part }: { part: WorkflowDataUIPart }) {
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

function AstrBotAssistantMessageParts({
  message,
  onToolApproval,
  onSuggestedFollowUpSelect,
  showSuggestedFollowUps,
}: {
  message: WorkflowUIMessage;
  onToolApproval?: (input: {
    toolCallId: string;
    toolName: string;
    action: 'approve' | 'reject';
    comment?: string;
  }) => Promise<void>;
  onSuggestedFollowUpSelect?: (question: string) => void;
  showSuggestedFollowUps: boolean;
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
      return isWorkflowMessageUIPart(part) || isWorkflowStatusUIPart(part);
    });

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
      <div className="flex w-full min-w-0 flex-col gap-3 text-[15px] leading-7">
        {renderableParts.map(({ part, index }) => {
          if (part.type === 'text') {
            const followUps = parseSuggestedFollowUps(part.text);
            const displayText = followUps?.textWithoutQuestions ?? part.text;

            return (
              <div key={`text-${message.id}-${index}`} className="min-w-0">
                <div className="min-w-0 break-words text-foreground/90">
                  <Markdown>{displayText}</Markdown>
                </div>
                {followUps && showSuggestedFollowUps ? (
                  <div className="mt-2">
                    <SuggestedFollowUpButtons
                      questions={followUps.questions}
                      onSelect={onSuggestedFollowUpSelect}
                    />
                  </div>
                ) : null}
              </div>
            );
          }

          if (part.type === 'file') {
            const attachment = getFileAttachment(part);
            if (!attachment) {
              return null;
            }

            return (
              <div key={`file-${message.id}-${index}`}>
                <AttachmentList attachments={[attachment]} />
              </div>
            );
          }

          if (part.type === 'reasoning' && typeof part.text === 'string') {
            const reasoningId = `reasoning-${message.id}-${index}`;
            const isExpanded = expandedReasoningParts[reasoningId] ?? false;

            return (
              <div key={reasoningId} className="min-w-0">
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
                  className="-mx-1 inline-flex max-w-full cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left text-foreground/70 text-sm leading-6 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <Sparkles className="size-3.5 shrink-0 text-[#6d9ec3]" />
                  <span className="min-w-0 truncate">思考过程</span>
                  <ChevronRight
                    className={cn(
                      'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none',
                      isExpanded && 'rotate-90',
                    )}
                  />
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
                      <div className="mt-2 ml-6 rounded-lg border border-border/50 bg-muted/20 px-3 py-3">
                        <div className="whitespace-pre-wrap break-words text-foreground/80 text-sm leading-6">
                          {part.text}
                        </div>
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
            );
          }

          const toolPart = normalizeToolPart(part);
          if (toolPart) {
            const detailsId = `tool-details-${toolPart.toolCallId}-${index}`;
            const isExpanded = expandedToolCalls[toolPart.toolCallId] ?? false;
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
                className="min-w-0"
              >
                <ToolCallSummaryButton
                  part={toolPart}
                  detailsId={detailsId}
                  isExpanded={isExpanded}
                  onToggle={() => {
                    setExpandedToolCalls((current) => ({
                      ...current,
                      [toolPart.toolCallId]: !isExpanded,
                    }));
                  }}
                />

                {canRespondApproval ? (
                  <div className="mt-2 ml-6 flex flex-wrap gap-2">
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
                      <div className="mt-2 ml-6 rounded-lg border border-border/50 bg-muted/20 px-3 py-3">
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
          }

          if (isWorkflowMessageUIPart(part) || isWorkflowStatusUIPart(part)) {
            const workflowSuffix =
              part.data.kind === 'message'
                ? `${part.data.type}-${part.data.eventType}`
                : `${part.data.type}-${index}`;
            const workflowId = `workflow-${message.id}-${workflowSuffix}`;
            const isExpanded = expandedWorkflowParts[workflowId] ?? false;

            return (
              <div key={workflowId} className="min-w-0">
                <WorkflowSummaryButton
                  part={part}
                  detailsId={`${workflowId}-details`}
                  isExpanded={isExpanded}
                  onToggle={() => {
                    setExpandedWorkflowParts((current) => ({
                      ...current,
                      [workflowId]: !isExpanded,
                    }));
                  }}
                />

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
                      <div className="mt-2 ml-6 rounded-lg border border-border/50 bg-muted/20 px-3 py-3">
                        <WorkflowDetails part={part} />
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
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
  showAssistantGlyph,
  showSuggestedFollowUps,
  onToolApproval,
  onSuggestedFollowUpSelect,
  onRevert,
  setMessages,
  regenerate,
}: {
  chatId: string;
  message: WorkflowUIMessage;
  isLoading: boolean;
  showAssistantGlyph: boolean;
  showSuggestedFollowUps: boolean;
  onToolApproval?: (input: {
    toolCallId: string;
    toolName: string;
    action: 'approve' | 'reject';
    comment?: string;
  }) => Promise<void>;
  onSuggestedFollowUpSelect?: (question: string) => void;
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
        className="group/message mx-auto w-full max-w-full px-3 sm:max-w-[920px] sm:px-4"
        initial={{ y: 5, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        data-message-id={message.id}
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
          {message.role === 'assistant' &&
            (showAssistantGlyph ? (
              <AssistantGlyph />
            ) : (
              <div className="size-7 shrink-0" aria-hidden="true" />
            ))}

          <div className="flex w-full min-w-0 flex-col gap-2 group-data-[role=assistant]/message:items-start group-data-[role=user]/message:items-end">
            {message.role === 'user' &&
              hasRenderableContent &&
              mode === 'view' && (
                <div className="flex w-full flex-row items-start justify-end gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        className="h-fit rounded-full px-2 text-muted-foreground opacity-0 group-hover/message:opacity-100"
                        onClick={() => {
                          setMode('edit');
                        }}
                      >
                        <PencilEditIcon />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Edit message</TooltipContent>
                  </Tooltip>

                  <div className="flex min-w-0 max-w-full flex-col gap-3 overflow-hidden rounded-2xl bg-[#e7ecf5] px-4 py-2.5 text-foreground shadow-none dark:bg-muted">
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
                <div className="flex w-full flex-row items-start justify-end gap-2">
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
              <AstrBotAssistantMessageParts
                message={message}
                onToolApproval={onToolApproval}
                onSuggestedFollowUpSelect={onSuggestedFollowUpSelect}
                showSuggestedFollowUps={showSuggestedFollowUps}
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
    if (prevProps.showAssistantGlyph !== nextProps.showAssistantGlyph) {
      return false;
    }
    if (prevProps.showSuggestedFollowUps !== nextProps.showSuggestedFollowUps) {
      return false;
    }
    if (prevProps.message.id !== nextProps.message.id) return false;
    if (prevProps.message.role !== nextProps.message.role) return false;
    if (prevProps.onToolApproval !== nextProps.onToolApproval) return false;
    if (
      prevProps.onSuggestedFollowUpSelect !==
      nextProps.onSuggestedFollowUpSelect
    ) {
      return false;
    }
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
      className="group/message mx-auto w-full max-w-full px-3 sm:max-w-[920px] sm:px-4"
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
        <AssistantGlyph />

        <div className="flex w-full min-w-0 flex-col gap-2">
          <div className="flex flex-col gap-4 text-muted-foreground">
            Thinking...
          </div>
        </div>
      </div>
    </motion.div>
  );
};
