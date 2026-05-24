import type { ChatRequestOptions } from 'ai';
import equal from 'fast-deep-equal';
import { memo } from 'react';

import type { WorkflowUIMessage } from '@/types/workflow';
import { PreviewMessage, ThinkingMessage } from './message';
import { Overview } from './overview';
import { DecisionCard } from './decision-card';
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

  return (
    <div
      ref={messagesContainerRef}
      className="flex flex-1 min-w-0 flex-col gap-6 overflow-y-scroll overflow-x-hidden pt-4"
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
      {pendingDecisions?.filter(d => d.status === 'sent' || d.status === 'pending').map((decision) => (
        <div key={decision.decision_id} className="px-4">
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
        className="shrink-0 min-w-[24px] min-h-[24px]"
      />
    </div>
  );
}

export const Messages = memo(PureMessages, (prevProps, nextProps) => {
  if (prevProps.chatId !== nextProps.chatId) return false;
  if (prevProps.isLoading !== nextProps.isLoading) return false;
  if (prevProps.isLoading && nextProps.isLoading) return false;
  if (prevProps.messages.length !== nextProps.messages.length) return false;
  if (!equal(prevProps.messages, nextProps.messages)) return false;
  if (prevProps.pendingDecisions?.length !== nextProps.pendingDecisions?.length) return false;

  return true;
});
