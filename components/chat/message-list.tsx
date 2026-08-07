import type { ChatRequestOptions } from 'ai';
import equal from 'fast-deep-equal';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowDown, ArrowUp, MessageSquareQuote, Send, X } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';

import type { WorkflowUIMessage } from '@/types/workflow';
import { DecisionCard } from '@/components/decision-card';
import { PreviewMessage, ThinkingMessage } from '@/components/message';
import { Overview } from '@/components/overview';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useScrollToBottom } from '@/components/use-scroll-to-bottom';
import { useI18n } from '@/components/i18n-provider';

interface PendingDecision {
  decision_id: string;
  type: 'l2_auth' | 'question';
  task_id: string;
  session_id: string;
  command?: string;
  score?: number;
  reason?: string;
  question?: string;
  prompts?: Array<{
    question: string;
    header?: string;
    options?: string[];
    multiple?: boolean;
  }>;
  options?: string[];
  status: string;
  created_at: string;
  timeout_at: string;
}

function hasRenderableAssistantParts(message: WorkflowUIMessage): boolean {
  return message.parts.some((part) => {
    if (part.type === 'text') {
      return part.text.trim().length > 0;
    }

    if (part.type === 'file') {
      return typeof part.url === 'string' && part.url.length > 0;
    }

    if (part.type === 'reasoning') {
      return typeof part.text === 'string' && part.text.trim().length > 0;
    }

    if (part.type === 'dynamic-tool') {
      return true;
    }

    if (part.type.startsWith('tool-')) {
      return true;
    }

    if (part.type === 'data-workflow') {
      return (
        part.data.kind === 'message' ||
        (part.data.kind === 'status' &&
          typeof part.data.agentName === 'string' &&
          part.data.agentName.trim().length > 0)
      );
    }

    return false;
  });
}

interface MessagesProps {
  chatId: string;
  isLoading: boolean;
  messages: Array<WorkflowUIMessage>;
  pendingDecisions?: PendingDecision[];
  onPromptSelect?: (prompt: string) => void;
  onToolApproval?: (input: {
    toolCallId: string;
    toolName: string;
    action: 'approve' | 'reject';
    comment?: string;
  }) => Promise<void>;
  onDecisionResolved?: (decisionId: string, action: string) => void;
  onFollowUpSubmit?: (input: {
    messageId: string;
    question: string;
    selectedText: string;
  }) => Promise<void>;
  onSuggestedFollowUpSelect?: (question: string) => void;
  setMessages: (
    messages:
      | WorkflowUIMessage[]
      | ((messages: WorkflowUIMessage[]) => WorkflowUIMessage[]),
  ) => void;
  regenerate: (
    options?: { messageId?: string } & ChatRequestOptions,
  ) => Promise<void>;
}

type InlineFollowUpSelection = {
  messageId: string;
  selectedText: string;
  x: number;
  y: number;
};

function isInsideCodeBlock(node: Node): boolean {
  let current: Node | null = node;
  while (current) {
    if (current instanceof HTMLElement) {
      const tagName = current.tagName.toLowerCase();
      if (tagName === 'code' || tagName === 'pre') {
        return true;
      }
    }
    current = current.parentNode;
  }

  return false;
}

function getElementFromNode(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

function clampFollowUpPosition(input: { x: number; y: number }) {
  if (typeof window === 'undefined') {
    return input;
  }

  return {
    x: Math.min(
      Math.max(input.x - 150, 12),
      Math.max(12, window.innerWidth - 340),
    ),
    y: Math.min(
      Math.max(input.y + 14, 12),
      Math.max(12, window.innerHeight - 210),
    ),
  };
}

function PureMessages({
  chatId,
  isLoading,
  messages,
  pendingDecisions,
  onPromptSelect,
  onToolApproval,
  onDecisionResolved,
  onFollowUpSubmit,
  onSuggestedFollowUpSelect,
  setMessages,
  regenerate,
}: MessagesProps) {
  const { t } = useI18n();
  const lastMessage = messages[messages.length - 1];
  const shouldShowThinking =
    isLoading &&
    messages.length > 0 &&
    (lastMessage.role === 'user' ||
      (lastMessage.role === 'assistant' &&
        !hasRenderableAssistantParts(lastMessage)));
  const shouldHideLastAssistantPlaceholder =
    shouldShowThinking &&
    lastMessage.role === 'assistant' &&
    !hasRenderableAssistantParts(lastMessage);
  const [messagesContainerRef, messagesEndRef] =
    useScrollToBottom<HTMLDivElement>(lastMessage, shouldShowThinking, {
      scrollOnMount: messages.length > 0,
    });

  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [showScrollToTop, setShowScrollToTop] = useState(false);
  const [followUpSelection, setFollowUpSelection] =
    useState<InlineFollowUpSelection | null>(null);
  const [followUpQuestion, setFollowUpQuestion] = useState('');
  const [isSubmittingFollowUp, setIsSubmittingFollowUp] = useState(false);
  const followUpPopoverRef = useRef<HTMLDivElement>(null);
  const updateScrollButtonVisibility = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;

    setShowScrollToBottom(distanceFromBottom > 180);
    setShowScrollToTop(container.scrollTop > 24);
  }, [messagesContainerRef]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    updateScrollButtonVisibility();
    container.addEventListener('scroll', updateScrollButtonVisibility, {
      passive: true,
    });
    return () =>
      container.removeEventListener('scroll', updateScrollButtonVisibility);
  }, [messagesContainerRef, updateScrollButtonVisibility]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || !onFollowUpSubmit) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const handleMouseUp = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-inline-follow-up-popover]')
      ) {
        return;
      }

      clearTimer();
      timer = setTimeout(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
          return;
        }

        const selectedText = selection.toString().trim();
        if (!selectedText) {
          return;
        }

        const range = selection.getRangeAt(0);
        if (
          !container.contains(range.startContainer) ||
          !container.contains(range.endContainer) ||
          isInsideCodeBlock(range.startContainer) ||
          isInsideCodeBlock(range.endContainer)
        ) {
          return;
        }

        const startMessage = getElementFromNode(range.startContainer)?.closest(
          '[data-role="assistant"][data-message-id]',
        );
        const endMessage = getElementFromNode(range.endContainer)?.closest(
          '[data-role="assistant"][data-message-id]',
        );
        if (!startMessage || startMessage !== endMessage) {
          return;
        }

        const messageId = startMessage.getAttribute('data-message-id');
        if (!messageId) {
          return;
        }

        const position = clampFollowUpPosition({
          x: event.clientX,
          y: event.clientY,
        });
        setFollowUpSelection({
          messageId,
          selectedText,
          ...position,
        });
        setFollowUpQuestion('');
      }, 140);
    };

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-inline-follow-up-popover]')
      ) {
        return;
      }

      setFollowUpSelection(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFollowUpSelection(null);
      }
    };

    const handleScroll = () => {
      setFollowUpSelection(null);
    };

    container.addEventListener('mouseup', handleMouseUp);
    container.addEventListener('scroll', handleScroll, { passive: true });
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      clearTimer();
      container.removeEventListener('mouseup', handleMouseUp);
      container.removeEventListener('scroll', handleScroll);
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [messagesContainerRef, onFollowUpSubmit]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Message/loading changes affect rendered height, so this effect intentionally rechecks scroll controls after those renders.
  useEffect(() => {
    const frame = requestAnimationFrame(updateScrollButtonVisibility);
    return () => cancelAnimationFrame(frame);
  }, [
    isLoading,
    messages.length,
    shouldShowThinking,
    updateScrollButtonVisibility,
  ]);

  const scrollToTop = useCallback(() => {
    setShowScrollToTop(false);
    messagesContainerRef.current?.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  }, [messagesContainerRef]);

  const scrollToBottom = useCallback(() => {
    setShowScrollToBottom(false);
    messagesEndRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'end',
    });
  }, [messagesEndRef]);

  const submitInlineFollowUp = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!followUpSelection || !onFollowUpSubmit) {
        return;
      }

      setIsSubmittingFollowUp(true);
      try {
        await onFollowUpSubmit({
          messageId: followUpSelection.messageId,
          question: followUpQuestion,
          selectedText: followUpSelection.selectedText,
        });
        window.getSelection()?.removeAllRanges();
        setFollowUpSelection(null);
        setFollowUpQuestion('');
      } finally {
        setIsSubmittingFollowUp(false);
      }
    },
    [followUpQuestion, followUpSelection, onFollowUpSubmit],
  );

  return (
    <div className="relative min-h-0 min-w-0 flex-1">
      <div
        ref={messagesContainerRef}
        className="flex h-full min-h-0 flex-col gap-8 overflow-y-auto overflow-x-hidden overscroll-contain px-4 pt-5 pb-32 md:px-6 md:pt-8 md:pb-36"
      >
        {messages.length === 0 && <Overview onPromptSelect={onPromptSelect} />}

        {messages.map((message, index) => {
          if (
            shouldHideLastAssistantPlaceholder &&
            index === messages.length - 1
          ) {
            return null;
          }

          const showSuggestedFollowUps =
            message.role === 'assistant' &&
            index === messages.length - 1 &&
            !isLoading;

          return (
            <PreviewMessage
              key={message.id}
              chatId={chatId}
              message={message}
              isLoading={isLoading && messages.length - 1 === index}
              showSuggestedFollowUps={showSuggestedFollowUps}
              onToolApproval={onToolApproval}
              onSuggestedFollowUpSelect={onSuggestedFollowUpSelect}
              setMessages={setMessages}
              regenerate={regenerate}
            />
          );
        })}

        {shouldShowThinking ? <ThinkingMessage /> : null}

        {/* Inline pending decisions (L2 auth + ask_question) */}
        {pendingDecisions
          ?.filter((d) => d.status === 'sent' || d.status === 'pending')
          .map((decision) => (
            <div key={decision.decision_id}>
              <DecisionCard
                decision={decision}
                chatId={chatId}
                onResolved={(decisionId, action) => {
                  onDecisionResolved?.(decisionId, action);
                }}
              />
            </div>
          ))}

        <div
          ref={messagesEndRef}
          className="min-h-[24px] min-w-[24px] shrink-0"
        />
      </div>

      <AnimatePresence>
        {followUpSelection && onFollowUpSubmit ? (
          <motion.div
            ref={followUpPopoverRef}
            data-inline-follow-up-popover
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="fixed z-50 w-[min(calc(100vw-24px),328px)] rounded-xl border border-border/70 bg-background/95 p-3 shadow-2xl backdrop-blur"
            style={{
              left: followUpSelection.x,
              top: followUpSelection.y,
            }}
          >
            <form
              className="flex flex-col gap-2"
              onSubmit={submitInlineFollowUp}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2 text-foreground text-sm">
                  <MessageSquareQuote className="size-4 shrink-0 text-[#6d9ec3]" />
                  <span className="font-medium">
                    {t('chat.followUp.title')}
                  </span>
                </div>
                <button
                  type="button"
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={t('chat.followUp.close')}
                  onClick={() => {
                    setFollowUpSelection(null);
                  }}
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="line-clamp-3 rounded-lg bg-muted/70 px-2.5 py-2 text-muted-foreground text-xs leading-5">
                {followUpSelection.selectedText}
              </div>

              <Textarea
                autoFocus
                value={followUpQuestion}
                onChange={(event) => {
                  setFollowUpQuestion(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={t('chat.followUp.placeholder')}
                className="min-h-20 resize-none rounded-lg"
              />

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFollowUpSelection(null);
                  }}
                >
                  {t('chat.followUp.cancel')}
                </Button>
                <Button type="submit" size="sm" disabled={isSubmittingFollowUp}>
                  <Send className="size-4" />
                  {t('chat.followUp.send')}
                </Button>
              </div>
            </form>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {showScrollToTop || showScrollToBottom ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.2 }}
            className="absolute right-5 bottom-28 z-10 flex flex-col gap-2"
          >
            <AnimatePresence initial={false}>
              {showScrollToTop ? (
                <motion.button
                  key="scroll-to-top"
                  type="button"
                  layout
                  initial={{ opacity: 0, y: 8, scale: 0.86 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.86 }}
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                  onClick={scrollToTop}
                  className="flex size-11 items-center justify-center rounded-full border border-border/70 bg-background/95 text-foreground shadow-md backdrop-blur transition-[color,background-color,box-shadow,transform] duration-150 ease-out hover:bg-muted hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 active:scale-95 motion-reduce:transition-colors motion-reduce:active:scale-100"
                  aria-label="Scroll to top"
                >
                  <ArrowUp className="size-5" />
                </motion.button>
              ) : null}

              {showScrollToBottom ? (
                <motion.button
                  key="scroll-to-bottom"
                  type="button"
                  layout
                  initial={{ opacity: 0, y: 8, scale: 0.86 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.86 }}
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                  onClick={scrollToBottom}
                  className="flex size-11 items-center justify-center rounded-full border border-border/70 bg-background/95 text-foreground shadow-md backdrop-blur transition-[color,background-color,box-shadow,transform] duration-150 ease-out hover:bg-muted hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 active:scale-95 motion-reduce:transition-colors motion-reduce:active:scale-100"
                  aria-label="Scroll to bottom"
                >
                  <ArrowDown className="size-5" />
                </motion.button>
              ) : null}
            </AnimatePresence>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export const Messages = memo(PureMessages, (prevProps, nextProps) => {
  if (prevProps.chatId !== nextProps.chatId) return false;
  if (prevProps.isLoading !== nextProps.isLoading) return false;
  if (prevProps.isLoading && nextProps.isLoading) return false;
  if (prevProps.messages.length !== nextProps.messages.length) return false;
  if (!equal(prevProps.messages, nextProps.messages)) return false;
  if (prevProps.pendingDecisions?.length !== nextProps.pendingDecisions?.length)
    return false;
  if (prevProps.onFollowUpSubmit !== nextProps.onFollowUpSubmit) return false;
  if (
    prevProps.onSuggestedFollowUpSelect !== nextProps.onSuggestedFollowUpSelect
  ) {
    return false;
  }

  return true;
});
