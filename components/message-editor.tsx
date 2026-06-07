'use client';

import type { ChatRequestOptions } from 'ai';
import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import type { UserMessagePart, WorkflowUIMessage } from '@/types/workflow';
import {
  AttachmentButton,
  AttachmentList,
  type ComposerAttachment,
  filePartToComposerAttachment,
  fileToComposerAttachment,
} from './attachments';
import {
  SlashCommandMenu,
  applySlashCommand,
  getSlashCommandMatch,
  useSlashCommandNavigation,
} from './slash-command-menu';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';

function getTextFromParts(message: WorkflowUIMessage): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function getAttachmentsFromParts(
  message: WorkflowUIMessage,
): ComposerAttachment[] {
  return message.parts.flatMap((part) => {
    if (part.type !== 'file') {
      return [];
    }

    return [filePartToComposerAttachment(part)];
  });
}

export type MessageEditorProps = {
  message: WorkflowUIMessage;
  setMode: Dispatch<SetStateAction<'view' | 'edit'>>;
  setMessages: (
    messages:
      | WorkflowUIMessage[]
      | ((messages: WorkflowUIMessage[]) => WorkflowUIMessage[]),
  ) => void;
  regenerate: (
    options?: { messageId?: string } & ChatRequestOptions,
  ) => Promise<void>;
};

export function MessageEditor({
  message,
  setMode,
  setMessages,
  regenerate,
}: MessageEditorProps) {
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const [draftContent, setDraftContent] = useState<string>(
    getTextFromParts(message),
  );
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(
    getAttachmentsFromParts(message),
  );
  const [cursor, setCursor] = useState<number>(
    getTextFromParts(message).length,
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      adjustHeight();
    }
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    requestAnimationFrame(() => {
      textarea.focus({ preventScroll: true });
      const cursorPosition = textarea.value.length;
      textarea.setSelectionRange(cursorPosition, cursorPosition);
    });
  }, []);

  const adjustHeight = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight + 2}px`;
    }
  };

  const handleInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraftContent(event.target.value);
    setCursor(event.target.selectionStart ?? event.target.value.length);
    adjustHeight();
  };

  const insertSlashCommand = (
    command: Parameters<typeof applySlashCommand>[2],
  ) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const match = getSlashCommandMatch(draftContent, cursor);
    if (!match) {
      return;
    }

    const { nextValue, nextCursor } = applySlashCommand(
      draftContent,
      match,
      command,
    );
    setDraftContent(nextValue);
    setCursor(nextCursor);

    requestAnimationFrame(() => {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(nextCursor, nextCursor);
      adjustHeight();
    });
  };

  const slashCommands = useSlashCommandNavigation(
    draftContent,
    cursor,
    insertSlashCommand,
  );

  const addFiles = async (files: FileList | File[]) => {
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
  };

  return (
    <div className="flex w-full flex-col gap-2">
      <input
        type="file"
        ref={fileInputRef}
        multiple
        className="-top-4 -left-4 pointer-events-none fixed size-0.5 opacity-0"
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
        aria-label="Edit message composer"
        className="relative flex flex-col gap-3 rounded-2xl border bg-muted/50 px-3 py-3"
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          void addFiles(event.dataTransfer.files);
        }}
      >
        <AttachmentList
          attachments={attachments}
          onRemove={(attachmentId) => {
            setAttachments((current) =>
              current.filter((attachment) => attachment.id !== attachmentId),
            );
          }}
        />

        <SlashCommandMenu
          value={draftContent}
          cursor={cursor}
          activeIndex={slashCommands.activeIndex}
          onActiveIndexChange={slashCommands.setActiveIndex}
          onSelect={insertSlashCommand}
        />

        <Textarea
          ref={textareaRef}
          className="!text-base w-full resize-none overflow-hidden rounded-xl border-0 bg-transparent px-0 pt-0 pb-10 shadow-none outline-none focus-visible:ring-0"
          value={draftContent}
          onChange={handleInput}
          onClick={(event) => {
            setCursor(
              event.currentTarget.selectionStart ?? draftContent.length,
            );
          }}
          onKeyUp={(event) => {
            setCursor(
              event.currentTarget.selectionStart ?? draftContent.length,
            );
          }}
          onSelect={(event) => {
            setCursor(
              event.currentTarget.selectionStart ?? draftContent.length,
            );
          }}
          onKeyDown={(event) => {
            slashCommands.onKeyDown(event);
          }}
        />

        <div className="absolute bottom-1 left-1 flex items-center">
          <AttachmentButton onClick={() => fileInputRef.current?.click()} />
        </div>
      </div>

      <div className="flex flex-row justify-end gap-2">
        <Button
          variant="outline"
          className="h-fit px-3 py-2"
          onClick={() => {
            setMode('view');
          }}
        >
          Cancel
        </Button>
        <Button
          variant="default"
          className="h-fit px-3 py-2"
          disabled={isSubmitting}
          onClick={async () => {
            setIsSubmitting(true);
            const messageId = message.id;
            const updatedParts: UserMessagePart[] = [
              ...(draftContent.trim()
                ? [{ type: 'text' as const, text: draftContent }]
                : []),
              ...attachments.map((attachment) => ({
                type: 'file' as const,
                filename: attachment.name,
                mediaType: attachment.mediaType,
                providerMetadata: attachment.providerMetadata,
                url: attachment.url,
              })),
            ];

            if (!messageId) {
              toast.error('Something went wrong, please try again!');
              setIsSubmitting(false);
              return;
            }

            setMessages((messages) => {
              const index = messages.findIndex((m) => m.id === message.id);

              if (index !== -1) {
                const updatedMessage: WorkflowUIMessage = {
                  ...message,
                  parts: updatedParts,
                };

                return [
                  ...messages.slice(0, index),
                  updatedMessage,
                  ...messages.slice(index + 1),
                ];
              }

              return messages;
            });

            setMode('view');
            try {
              await regenerate({
                messageId,
                body: {
                  input: {
                    parts: updatedParts,
                  },
                },
              });
            } catch {
              toast.error('Failed to regenerate response');
            } finally {
              setIsSubmitting(false);
            }
          }}
        >
          {isSubmitting ? 'Sending...' : 'Send'}
        </Button>
      </div>
    </div>
  );
}
