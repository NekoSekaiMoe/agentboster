import { memo, useCallback } from 'react';
import { toast } from 'sonner';
import { useCopyToClipboard } from 'usehooks-ts';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { WorkflowUIMessage } from '@/types/workflow';
import { ChevronLeft, ChevronRight } from 'lucide-react';
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
  onEditVersionChange,
  onRegenerate,
  onGenerationVersionChange,
}: {
  message: WorkflowUIMessage;
  isLoading: boolean;
  chatId?: string;
  onRevert?: (messageId: string) => void;
  onEditVersionChange?: (messageId: string, newIndex: number) => void;
  onRegenerate?: (messageId: string) => void;
  onGenerationVersionChange?: (messageId: string, newIndex: number) => void;
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

  const handlePreviousVersion = useCallback(() => {
    const currentIndex = message.metadata?.currentEditIndex ?? 0;
    if (currentIndex > 0) {
      onEditVersionChange?.(message.id, currentIndex - 1);
    }
  }, [message.id, message.metadata?.currentEditIndex, onEditVersionChange]);

  const handleNextVersion = useCallback(() => {
    const editHistory = message.metadata?.editHistory || [];
    const currentIndex = message.metadata?.currentEditIndex ?? 0;
    if (currentIndex < editHistory.length - 1) {
      onEditVersionChange?.(message.id, currentIndex + 1);
    }
  }, [
    message.id,
    message.metadata?.currentEditIndex,
    message.metadata?.editHistory,
    onEditVersionChange,
  ]);

  const handleRegenerate = useCallback(() => {
    onRegenerate?.(message.id);
  }, [message.id, onRegenerate]);

  const handlePreviousGeneration = useCallback(() => {
    const currentIndex = message.metadata?.currentGenerationIndex ?? 0;
    if (currentIndex > 0) {
      onGenerationVersionChange?.(message.id, currentIndex - 1);
    }
  }, [
    message.id,
    message.metadata?.currentGenerationIndex,
    onGenerationVersionChange,
  ]);

  const handleNextGeneration = useCallback(() => {
    const generationHistory = message.metadata?.generationHistory || [];
    const currentIndex = message.metadata?.currentGenerationIndex ?? 0;
    if (currentIndex < generationHistory.length - 1) {
      onGenerationVersionChange?.(message.id, currentIndex + 1);
    }
  }, [
    message.id,
    message.metadata?.currentGenerationIndex,
    message.metadata?.generationHistory,
    onGenerationVersionChange,
  ]);

  if (isLoading && message.role === 'assistant') return null;
  if (!textContent.trim() && message.role === 'assistant') return null;

  const isUser = message.role === 'user';
  const timestamp = formatMessageTime(message.metadata?.createdAt);
  const editHistory = message.metadata?.editHistory || [];
  const currentEditIndex = message.metadata?.currentEditIndex ?? 0;
  const hasEditHistory = editHistory.length > 1; // Only show if there are 2+ versions
  const canGoPrevious = currentEditIndex > 0;
  const canGoNext = currentEditIndex < editHistory.length - 1;

  // Debug logging
  if (isUser && editHistory.length > 0) {
    console.log('Message actions for user message:', {
      messageId: message.id,
      historyLength: editHistory.length,
      currentIndex: currentEditIndex,
      hasEditHistory,
    });
  }

  // Generation history for assistant messages
  const generationHistory = message.metadata?.generationHistory || [];
  const currentGenerationIndex = message.metadata?.currentGenerationIndex ?? 0;
  const hasGenerationHistory = generationHistory.length > 1; // Only show if there are 2+ versions
  const canGoPreviousGeneration = currentGenerationIndex > 0;
  const canGoNextGeneration =
    currentGenerationIndex < generationHistory.length - 1;

  return (
    <TooltipProvider delayDuration={0}>
      <div
        className={cn(
          'flex flex-row items-center gap-2 text-muted-foreground text-xs',
          isUser && 'justify-end',
        )}
      >
        {timestamp ? <span className="leading-7">{timestamp}</span> : null}

        {/* Generation version navigation — only for assistant messages with generation history */}
        {!isUser && hasGenerationHistory && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className="size-7 rounded-md border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground disabled:opacity-30"
                  variant="ghost"
                  onClick={handlePreviousGeneration}
                  disabled={!canGoPreviousGeneration}
                >
                  <ChevronLeft className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Previous generation</TooltipContent>
            </Tooltip>
            <span className="text-xs leading-7">
              {currentGenerationIndex + 1}/{generationHistory.length}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className="size-7 rounded-md border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground disabled:opacity-30"
                  variant="ghost"
                  onClick={handleNextGeneration}
                  disabled={!canGoNextGeneration}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Next generation</TooltipContent>
            </Tooltip>
          </>
        )}

        {/* Regenerate button — only for assistant messages */}
        {!isUser && onRegenerate && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="size-7 rounded-md border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground"
                variant="ghost"
                onClick={handleRegenerate}
              >
                <RefreshCwIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Regenerate</TooltipContent>
          </Tooltip>
        )}

        {/* Edit version navigation — only for user messages with edit history */}
        {isUser && hasEditHistory && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className="size-7 rounded-md border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground disabled:opacity-30"
                  variant="ghost"
                  onClick={handlePreviousVersion}
                  disabled={!canGoPrevious}
                >
                  <ChevronLeft className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Previous version</TooltipContent>
            </Tooltip>
            <span className="text-xs leading-7">
              {currentEditIndex + 1}/{editHistory.length}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className="size-7 rounded-md border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground disabled:opacity-30"
                  variant="ghost"
                  onClick={handleNextVersion}
                  disabled={!canGoNext}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Next version</TooltipContent>
            </Tooltip>
          </>
        )}

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
