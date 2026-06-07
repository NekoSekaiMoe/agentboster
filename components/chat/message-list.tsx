import type { ChatRequestOptions } from 'ai';
import equal from 'fast-deep-equal';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';

import type { WorkflowUIMessage } from '@/types/workflow';
import { DecisionCard } from '@/components/decision-card';
import { PreviewMessage, ThinkingMessage } from '@/components/message';
import { Overview } from '@/components/overview';
import { useScrollToBottom } from '@/components/use-scroll-to-bottom';

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
  onRevert?: (messageId: string) => void;
  onDecisionResolved?: (decisionId: string, action: string) => void;
  setMessages: (
    messages:
      | WorkflowUIMessage[]
      | ((messages: WorkflowUIMessage[]) => WorkflowUIMessage[]),
  ) => void;
  regenerate: (
    options?: { messageId?: string } & ChatRequestOptions,
  ) => Promise<void>;
}

function PureMessages({
  chatId,
  isLoading,
  messages,
  pendingDecisions,
  onPromptSelect,
  onToolApproval,
  onRevert,
  onDecisionResolved,
  setMessages,
  regenerate,
}: MessagesProps) {
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
    useScrollToBottom<HTMLDivElement>(lastMessage, shouldShowThinking);

  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [showScrollToTop, setShowScrollToTop] = useState(false);
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

  return (
    <div className="relative min-h-0 min-w-0 flex-1">
      <div
        ref={messagesContainerRef}
        className="flex h-full min-h-0 flex-col gap-8 overflow-y-auto overflow-x-hidden overscroll-contain px-4 pt-5 pb-8 md:px-6 md:pt-8 md:pb-10"
      >
        {messages.length === 0 && <Overview onPromptSelect={onPromptSelect} />}

        {messages.map((message, index) => {
          if (
            shouldHideLastAssistantPlaceholder &&
            index === messages.length - 1
          ) {
            return null;
          }

          return (
            <PreviewMessage
              key={message.id}
              chatId={chatId}
              message={message}
              isLoading={isLoading && messages.length - 1 === index}
              onToolApproval={onToolApproval}
              onRevert={onRevert}
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
        {showScrollToTop || showScrollToBottom ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.2 }}
            className="absolute right-5 bottom-5 z-10 flex flex-col gap-2"
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
                  className="flex size-11 items-center justify-center rounded-full border border-border/70 bg-background/95 text-foreground shadow-md backdrop-blur transition-[color,background-color,box-shadow,transform] duration-150 ease-out hover:bg-muted hover:shadow-lg active:scale-95 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 motion-reduce:transition-colors motion-reduce:active:scale-100"
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
                  className="flex size-11 items-center justify-center rounded-full border border-border/70 bg-background/95 text-foreground shadow-md backdrop-blur transition-[color,background-color,box-shadow,transform] duration-150 ease-out hover:bg-muted hover:shadow-lg active:scale-95 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 motion-reduce:transition-colors motion-reduce:active:scale-100"
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

  return true;
});
