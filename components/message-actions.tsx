import { memo, useCallback } from 'react';
import { toast } from 'sonner';
import { useCopyToClipboard } from 'usehooks-ts';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { WorkflowUIMessage } from '@/types/workflow';
import { CopyIcon, RefreshCwIcon } from './icons';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip';

function getTextFromParts(message: WorkflowUIMessage): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function formatMessageTime(value: string | undefined): string {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${month}-${day} ${hours}:${minutes}`;
}

export function PureMessageActions({
  message,
  isLoading,
  chatId,
  onRevert,
}: {
  message: WorkflowUIMessage;
  isLoading: boolean;
  chatId?: string;
  onRevert?: (messageId: string) => void;
}) {
  const [_, copyToClipboard] = useCopyToClipboard();
  const textContent = getTextFromParts(message);

  const handleCopy = useCallback(async () => {
    await copyToClipboard(textContent);
    toast.success('Copied to clipboard!');
  }, [copyToClipboard, textContent]);

  const handleRevert = useCallback(() => {
    if (!chatId) return;
    onRevert?.(message.id);
  }, [chatId, message.id, onRevert]);

  if (isLoading && message.role === 'assistant') return null;
  if (!textContent.trim() && message.role === 'assistant') return null;

  const isUser = message.role === 'user';
  const timestamp = formatMessageTime(message.metadata?.createdAt);

  return (
    <TooltipProvider delayDuration={0}>
      <div
        className={cn(
          'flex flex-row items-center gap-2 text-muted-foreground text-xs',
          isUser && 'justify-end',
        )}
      >
        {timestamp ? <span className="leading-7">{timestamp}</span> : null}

        {/* Copy — both user and assistant */}
        {textContent.trim() && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="size-7 rounded-md border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground"
                variant="ghost"
                onClick={handleCopy}
              >
                <CopyIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy</TooltipContent>
          </Tooltip>
        )}
        {/* Revert — only user messages */}
        {isUser && chatId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="size-7 rounded-md border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground"
                variant="ghost"
                onClick={handleRevert}
              >
                <RefreshCwIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Revert to here</TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
}

export const MessageActions = memo(
  PureMessageActions,
  (prevProps, nextProps) => {
    if (prevProps.isLoading !== nextProps.isLoading) return false;
    if (prevProps.message.id !== nextProps.message.id) return false;
    if (prevProps.message.role !== nextProps.message.role) return false;
    if (prevProps.message.parts !== nextProps.message.parts) return false;
    return true;
  },
);
