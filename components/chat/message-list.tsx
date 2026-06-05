import type { ChatRequestOptions } from 'ai';
import equal from 'fast-deep-equal';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUp } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';

import type { WorkflowUIMessage } from '@/types/workflow';
import { DecisionCard } from './decision-card';
import { PreviewMessage, ThinkingMessage } from './message';
import { Overview } from './overview';
import { useScrollToBottom } from './use-scroll-to-bottom';

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
  const [messagesContainerRef, messagesEndRef] =
    useScrollToBottom<HTMLDivElement>(lastMessage, shouldShowThinking);

  const [showScrollToTop, setShowScrollToTop] = useState(false);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      setShowScrollToTop(container.scrollTop > 300);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [messagesContainerRef]);

  const scrollToTop = useCallback(() => {
    messagesContainerRef.current?.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  }, [messagesContainerRef]);

  return (
    <div className='relative min-w-0 flex-1'>
      <div
        ref={messagesContainerRef}
        className='flex h-full flex-col gap-8 overflow-x-hidden overflow-y-scroll px-4 py-6 md:px-6 md:py-8'
      >
        {messages.length === 0 && <Overview onPromptSelect={onPromptSelect} />}

        {messages.map((message, index) => (
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
        ))}

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
          className='min-h-[24px] min-w-[24px] shrink-0'
        />
      </div>

      <AnimatePresence>
        {showScrollToTop && (
          <motion.button
            type="button"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.2 }}
            onClick={scrollToTop}
            className='absolute bottom-6 right-6 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2'
            aria-label="Scroll to top"
          >
            <ArrowUp className="size-5" />
          </motion.button>
        )}
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
