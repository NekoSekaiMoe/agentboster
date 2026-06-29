import { memo, useCallback } from 'react';
import { toast } from 'sonner';
import { useCopyToClipboard } from 'usehooks-ts';

import { AudioPlayer } from '@/components/audio-player';
import { useI18n } from '@/components/i18n-provider';
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
  ttsEnabled = false,
  autoPlay = false,
}: {
  message: WorkflowUIMessage;
  isLoading: boolean;
  chatId?: string;
  onRevert?: (messageId: string) => void;
  onEditVersionChange?: (messageId: string, newIndex: number) => void;
  onRegenerate?: (messageId: string) => void;
  onGenerationVersionChange?: (messageId: string, newIndex: number) => void;
  ttsEnabled?: boolean;
  autoPlay?: boolean;
}) {
  const { t } = useI18n();
  const [_, copyToClipboard] = useCopyToClipboard();
  const textContent = getTextFromParts(message);

  const handleCopy = useCallback(async () => {
    await copyToClipboard(textContent);
    toast.success(t('toast.clipboard.copied'));
  }, [copyToClipboard, textContent, t]);

  const handleRevert = useCallback(() => {
    if (!chatId) return;
    onRevert?.(message.id);
  }, [chatId, message.id, onRevert]);

  const handlePreviousVersion = useCallback(() => {
    const currentIndex = message.metadata?.currentVersionIndex ?? 0;
    if (currentIndex > 0) {
      onEditVersionChange?.(message.id, currentIndex - 1);
    }
  }, [message.id, message.metadata?.currentVersionIndex, onEditVersionChange]);

  const handleNextVersion = useCallback(() => {
    const versions = message.metadata?.versions || [];
    const currentIndex = message.metadata?.currentVersionIndex ?? 0;
    if (currentIndex < versions.length - 1) {
      onEditVersionChange?.(message.id, currentIndex + 1);
    }
  }, [
    message.id,
    message.metadata?.currentVersionIndex,
    message.metadata?.versions,
    onEditVersionChange,
  ]);

  const handleRegenerate = useCallback(() => {
    onRegenerate?.(message.id);
  }, [message.id, onRegenerate]);

  const handlePreviousGeneration = useCallback(() => {
    const currentIndex = message.metadata?.currentVersionIndex ?? 0;
    if (currentIndex > 0) {
      onGenerationVersionChange?.(message.id, currentIndex - 1);
    }
  }, [
    message.id,
    message.metadata?.currentVersionIndex,
    onGenerationVersionChange,
  ]);

  const handleNextGeneration = useCallback(() => {
    const versions = message.metadata?.versions || [];
    const currentIndex = message.metadata?.currentVersionIndex ?? 0;
    if (currentIndex < versions.length - 1) {
      onGenerationVersionChange?.(message.id, currentIndex + 1);
    }
  }, [
    message.id,
    message.metadata?.currentVersionIndex,
    message.metadata?.versions,
    onGenerationVersionChange,
  ]);

  if (isLoading && message.role === 'assistant') return null;
  if (!textContent.trim() && message.role === 'assistant') return null;

  const isUser = message.role === 'user';
  const timestamp = formatMessageTime(message.metadata?.createdAt);
  const versions = message.metadata?.versions || [];
  const currentVersionIndex = message.metadata?.currentVersionIndex ?? 0;
  const hasMultipleVersions = versions.length > 1; // Only show if there are 2+ versions
  const canGoPrevious = currentVersionIndex > 0;
  const canGoNext = currentVersionIndex < versions.length - 1;

  return (
    <TooltipProvider delayDuration={0}>
      <div
        className={cn(
          'flex flex-row items-center gap-2 text-muted-foreground text-xs',
          isUser && 'justify-end',
        )}
      >
        {timestamp ? <span className="leading-7">{timestamp}</span> : null}

        {/* Generation version navigation — only for assistant messages with multiple versions */}
        {!isUser && hasMultipleVersions && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className="size-7 rounded-md border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground disabled:opacity-30"
                  variant="ghost"
                  onClick={handlePreviousGeneration}
                  disabled={!canGoPrevious}
                >
                  <ChevronLeft className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Previous generation</TooltipContent>
            </Tooltip>
            <span className="text-xs leading-7">
              {currentVersionIndex + 1}/{versions.length}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className="size-7 rounded-md border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground disabled:opacity-30"
                  variant="ghost"
                  onClick={handleNextGeneration}
                  disabled={!canGoNext}
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

        {/* Text-to-Speech playback — only for assistant messages when TTS is configured */}
        {!isUser && ttsEnabled && textContent.trim() && (
          <AudioPlayer text={textContent} autoPlay={autoPlay} />
        )}

        {/* Edit version navigation — only for user messages with multiple versions */}
        {isUser && hasMultipleVersions && (
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
              {currentVersionIndex + 1}/{versions.length}
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
    if (prevProps.ttsEnabled !== nextProps.ttsEnabled) return false;
    if (prevProps.autoPlay !== nextProps.autoPlay) return false;
    // Metadata carries versions and currentVersionIndex. Without this check,
    // version-switching UI (1/N counter and arrow buttons) does not re-render
    // when only metadata changes — e.g. after handleRegenerate's setTimeout
    // setMessages, which keeps the same parts reference while appending to
    // versions.
    if (prevProps.message.metadata !== nextProps.message.metadata) {
      return false;
    }
    return true;
  },
);
