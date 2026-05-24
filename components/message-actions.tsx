import { memo, useCallback } from 'react';
import { ofetch } from 'ofetch';
import { toast } from 'sonner';
import { useCopyToClipboard } from 'usehooks-ts';

import type { WorkflowUIMessage } from '@/types/workflow';
import { CopyIcon, RefreshCwIcon } from './icons';
import { Button } from '@/components/ui/button';
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

  const handleRevert = useCallback(async () => {
    if (!chatId) return;
    try {
      await ofetch(`/api/sessions/${chatId}/revert`, {
        method: 'POST',
        body: { message_id: message.id },
      });
      onRevert?.(message.id);
      toast.success('Reverted to this message');
    } catch {
      toast.error('Failed to revert');
    }
  }, [chatId, message.id, onRevert]);

  if (isLoading && message.role === 'assistant') return null;
  if (!textContent.trim() && message.role === 'assistant') return null;

  const isUser = message.role === 'user';

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex flex-row gap-1">
        {/* Copy — both user and assistant */}
        {textContent.trim() && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button className="py-1 px-2 h-fit text-muted-foreground" variant="outline" onClick={handleCopy}>
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
              <Button className="py-1 px-2 h-fit text-muted-foreground" variant="outline" onClick={handleRevert}>
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
