'use client';

import type { ChatRequestOptions, CreateUIMessage } from 'ai';
import type React from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useLocalStorage, useWindowSize } from 'usehooks-ts';

import { cn } from '@/lib/utils';
import type { UserMessagePart, WorkflowUIMessage } from '@/types/workflow';
import {
  AttachmentButton,
  AttachmentList,
  type ComposerAttachment,
  fileToComposerAttachment,
} from './attachments';
import { ArrowUpIcon, StopIcon } from './icons';
import {
  SlashCommandMenu,
  applySlashCommand,
  getSlashCommandMatch,
  useSlashCommandNavigation,
} from './slash-command-menu';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';

type ComposerMessage = { text: string } | CreateUIMessage<WorkflowUIMessage>;

const adjustHeight = (ref: React.RefObject<HTMLTextAreaElement | null>) => {
  if (ref.current) {
    ref.current.style.height = 'auto';
    ref.current.style.height = `${ref.current.scrollHeight + 2}px`;
  }
};

const resetHeight = (ref: React.RefObject<HTMLTextAreaElement | null>) => {
  if (ref.current) {
    ref.current.style.height = 'auto';
    ref.current.style.height = '98px';
  }
};

function PureMultimodalInput({
  chatId,
  focusTrigger = 0,
  input,
  setInput,
  isLoading,
  stop,
  sendMessage,
  className,
}: {
  chatId: string;
  focusTrigger?: number;
  input: string;
  setInput: (value: string) => void;
  isLoading: boolean;
  stop: () => void;
  sendMessage: (
    message?: ComposerMessage,
    options?: ChatRequestOptions,
  ) => Promise<void>;
  className?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { width } = useWindowSize();
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const [cursor, setCursor] = useState(0);
  const hasHydratedInputRef = useRef(false);

  useEffect(() => {
    if (textareaRef.current) {
      adjustHeight(textareaRef);
    }
  }, []);

  const [localStorageInput, setLocalStorageInput] = useLocalStorage(
    `chat-input:${chatId}`,
    '',
  );

  useEffect(() => {
    if (hasHydratedInputRef.current || !textareaRef.current) {
      return;
    }

    hasHydratedInputRef.current = true;

    const domValue = textareaRef.current.value;
    // Prefer DOM value over localStorage to handle hydration.
    const finalValue = domValue || localStorageInput || '';

    if (finalValue !== input) {
      setInput(finalValue);
    }

    requestAnimationFrame(() => {
      adjustHeight(textareaRef);
    });
  }, [input, localStorageInput, setInput]);

  useEffect(() => {
    if (localStorageInput === input) {
      return;
    }

    setLocalStorageInput(input);
  }, [input, localStorageInput, setLocalStorageInput]);

  useEffect(() => {
    if (textareaRef.current?.value !== input) {
      return;
    }

    adjustHeight(textareaRef);
  }, [input]);

  useEffect(() => {
    if (focusTrigger === 0 || !textareaRef.current) {
      return;
    }

    requestAnimationFrame(() => {
      const textarea = textareaRef.current;

      if (!textarea) {
        return;
      }

      const isActiveTextarea = document.activeElement === textarea;
      const cursorPosition = textarea.value.length;

      if (!isActiveTextarea) {
        textarea.focus();
        textarea.setSelectionRange(cursorPosition, cursorPosition);
        setCursor(cursorPosition);
      }

      adjustHeight(textareaRef);
    });
  }, [focusTrigger]);

  const handleInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(event.target.value);
    setCursor(event.target.selectionStart ?? event.target.value.length);
    adjustHeight(textareaRef);
  };

  const insertSlashCommand = useCallback(
    (command: Parameters<typeof applySlashCommand>[2]) => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }

      const match = getSlashCommandMatch(input, cursor);
      if (!match) {
        return;
      }

      const { nextValue, nextCursor } = applySlashCommand(
        input,
        match,
        command,
      );
      setInput(nextValue);
      setCursor(nextCursor);

      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(nextCursor, nextCursor);
        adjustHeight(textareaRef);
      });
    },
    [cursor, input, setInput],
  );

  const slashCommands = useSlashCommandNavigation(
    input,
    cursor,
    insertSlashCommand,
  );

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) {
      return;
    }

    try {
      const nextAttachments = await Promise.all(
        fileArray.map((file) => fileToComposerAttachment(file)),
      );

      setAttachments((current) => {
        const seen = new Set(current.map((attachment) => attachment.id));
        const deduped = nextAttachments.filter((attachment) => {
          if (seen.has(attachment.id)) {
            return false;
          }
          seen.add(attachment.id);
          return true;
        });

        return [...current, ...deduped];
      });
    } catch {
      toast.error('Failed to add attachment, please try again.');
    }
  }, []);

  const removeAttachment = useCallback((attachmentId: string) => {
    setAttachments((current) =>
      current.filter((attachment) => attachment.id !== attachmentId),
    );
  }, []);

  const submitForm = useCallback(async () => {
    if (!input.trim() && attachments.length === 0) return;

    const previousUrl =
      window.location.pathname + window.location.search + window.location.hash;

    window.history.replaceState({}, '', `/chat/${chatId}`);

    const nextParts: UserMessagePart[] = [
      ...(input.trim() ? [{ type: 'text' as const, text: input }] : []),
      ...attachments.map((attachment) => ({
        type: 'file' as const,
        filename: attachment.name,
        mediaType: attachment.mediaType,
        providerMetadata: attachment.providerMetadata,
        url: attachment.url,
      })),
    ];
    const previousInput = input;
    const previousAttachments = attachments;

    setInput('');
    setLocalStorageInput('');
    setAttachments([]);
    resetHeight(textareaRef);

    try {
      await sendMessage({
        parts: nextParts,
      });

      if (width && width > 768) {
        textareaRef.current?.focus();
      }
    } catch (error) {
      window.history.replaceState({}, '', previousUrl);
      setInput(previousInput);
      setLocalStorageInput(previousInput);
      setAttachments(previousAttachments);
      adjustHeight(textareaRef);
      toast.error(
        error instanceof Error ? error.message : 'Failed to send message.',
      );
    }
  }, [
    attachments,
    chatId,
    input,
    sendMessage,
    setInput,
    setLocalStorageInput,
    width,
  ]);

  return (
    <div className="relative w-full flex flex-col gap-4">
      <input
        type="file"
        ref={fileInputRef}
        multiple
        aria-label="Attach files"
        className="fixed -top-4 -left-4 size-0.5 opacity-0 pointer-events-none"
        tabIndex={-1}
        onChange={(event) => {
          if (event.target.files) {
            void addFiles(event.target.files);
            event.target.value = '';
          }
        }}
      />

      <div
        role="group"
        aria-label="Message composer"
        className={cn(
          'relative flex flex-col gap-3 rounded-2xl border bg-muted px-3 py-3 transition-colors dark:border-zinc-700',
          {
            'border-primary/60 bg-primary/5': isDragActive,
          },
          className,
        )}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragActive(true);
        }}
        onDragLeave={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          ) {
            return;
          }
          setIsDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragActive(false);
          void addFiles(event.dataTransfer.files);
        }}
      >
        <AttachmentList attachments={attachments} onRemove={removeAttachment} />

        <SlashCommandMenu
          value={input}
          cursor={cursor}
          activeIndex={slashCommands.activeIndex}
          onActiveIndexChange={slashCommands.setActiveIndex}
          onSelect={insertSlashCommand}
        />

        <Textarea
          ref={textareaRef}
          placeholder="Send a message..."
          value={input}
          onChange={handleInput}
          className="min-h-[24px] max-h-[calc(75dvh)] overflow-hidden resize-none border-0 bg-transparent px-0 pb-10 pt-0 !text-base shadow-none focus-visible:ring-0"
          rows={2}
          autoFocus
          onClick={(event) => {
            setCursor(event.currentTarget.selectionStart ?? input.length);
          }}
          onKeyUp={(event) => {
            setCursor(event.currentTarget.selectionStart ?? input.length);
          }}
          onSelect={(event) => {
            setCursor(event.currentTarget.selectionStart ?? input.length);
          }}
          onKeyDown={(event) => {
            if (slashCommands.onKeyDown(event)) {
              return;
            }

            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submitForm();
            }
          }}
        />

        <div className="absolute bottom-0 left-0 p-2 w-fit flex flex-row justify-end">
          <AttachmentButton onClick={() => fileInputRef.current?.click()} />
        </div>

        <div className="absolute bottom-0 right-0 p-2 w-fit flex flex-row justify-end gap-2">
          <SendButton
            input={input}
            hasAttachments={attachments.length > 0}
            submitForm={submitForm}
          />
          {isLoading ? <StopButton stop={stop} /> : null}
        </div>
      </div>
    </div>
  );
}

export const MultimodalInput = memo(
  PureMultimodalInput,
  (prevProps, nextProps) => {
    if (prevProps.chatId !== nextProps.chatId) return false;
    if (prevProps.focusTrigger !== nextProps.focusTrigger) return false;
    if (prevProps.input !== nextProps.input) return false;
    if (prevProps.isLoading !== nextProps.isLoading) return false;

    return true;
  },
);

function PureStopButton({
  stop,
}: {
  stop: () => void;
}) {
  return (
    <Button
      className="rounded-full p-1.5 h-fit border dark:border-zinc-600"
      onClick={(event) => {
        event.preventDefault();
        stop();
      }}
    >
      <StopIcon size={14} />
    </Button>
  );
}

const StopButton = memo(PureStopButton);

function PureSendButton({
  submitForm,
  input,
  hasAttachments,
}: {
  submitForm: () => Promise<void>;
  input: string;
  hasAttachments: boolean;
}) {
  return (
    <Button
      className="rounded-full p-1.5 h-fit border dark:border-zinc-600"
      onClick={(event) => {
        event.preventDefault();
        void submitForm();
      }}
      disabled={input.trim().length === 0 && !hasAttachments}
    >
      <ArrowUpIcon size={14} />
    </Button>
  );
}

const SendButton = memo(PureSendButton, (prevProps, nextProps) => {
  if (prevProps.input !== nextProps.input) return false;
  if (prevProps.hasAttachments !== nextProps.hasAttachments) return false;
  return true;
});
