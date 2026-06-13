'use client';

import type { ChatRequestOptions } from 'ai';
import {
  Dispatch,
  SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';

import type { UserMessagePart, WorkflowUIMessage } from '@/types/workflow';
import {
  AttachmentButton,
  AttachmentList,
  type AttachmentUploadProgress,
  type ComposerAttachment,
  buildAttachmentId,
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
  const [uploadProgress, setUploadProgress] = useState<
    AttachmentUploadProgress[]
  >([]);
  const [cursor, setCursor] = useState<number>(
    getTextFromParts(message).length,
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const adjustHeight = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight + 2}px`;
    }
  }, []);

  useEffect(() => {
    if (textareaRef.current) {
      adjustHeight();
    }
  }, [adjustHeight]);

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
    const fileIds = new Set(fileArray.map((file) => buildAttachmentId(file)));

    try {
      const nextAttachments = await Promise.all(
        fileArray.map((file) =>
          fileToComposerAttachment(file, (progress) => {
            setUploadProgress((current) => {
              const next = current.filter((item) => item.id !== progress.id);
              return [...next, progress];
            });
          }),
        ),
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
      setUploadProgress((current) =>
        current.filter(
          (progress) =>
            !nextAttachments.some(
              (attachment) => attachment.id === progress.id,
            ),
        ),
      );
    } catch {
      setUploadProgress((current) =>
        current.filter((progress) => !fileIds.has(progress.id)),
      );
      toast.error('Failed to add attachment, please try again.');
    }
  };

  return (
    <div className="flex w-full flex-col gap-2">
      <input
        type="file"
        ref={fileInputRef}
        multiple
        className="pointer-events-none fixed -top-4 -left-4 size-0.5 opacity-0"
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
          uploadProgress={uploadProgress}
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
          disabled={isSubmitting || uploadProgress.length > 0}
          onClick={async () => {
            if (uploadProgress.length > 0) {
              return;
            }

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

            // Build edit history BEFORE updating state
            const editHistory = message.metadata?.editHistory || [];
            const currentEditIndex = message.metadata?.currentEditIndex ?? -1;

            // Only add to history if content actually changed
            const currentText = getTextFromParts(message);
            const newText = draftContent.trim();
            const contentChanged = currentText !== newText;

            let newEditHistory = editHistory;
            let newEditIndex = currentEditIndex;

            if (contentChanged) {
              // If this is the first edit, initialize history with original message
              if (editHistory.length === 0) {
                const originalParts = message.parts
                  .filter(
                    (p): p is UserMessagePart =>
                      p.type === 'text' || p.type === 'file',
                  )
                  .map((p) => {
                    if (p.type === 'text') {
                      return { type: 'text' as const, text: p.text };
                    }
                    return {
                      type: 'file' as const,
                      filename: p.filename,
                      mediaType: p.mediaType,
                      url: p.url,
                      providerMetadata: p.providerMetadata,
                    };
                  });

                newEditHistory = [
                  {
                    parts: originalParts,
                    createdAt:
                      message.metadata?.createdAt || new Date().toISOString(),
                  },
                ];
                newEditIndex = 0;
              }

              // If we're not at the latest version, truncate history after current index
              if (currentEditIndex < newEditHistory.length - 1) {
                newEditHistory = newEditHistory.slice(0, currentEditIndex + 1);
              }

              // Add new version
              newEditHistory = [
                ...newEditHistory,
                {
                  parts: updatedParts,
                  createdAt: new Date().toISOString(),
                },
              ];
              newEditIndex = newEditHistory.length - 1;
            }

            // Build the updated message with editHistory
            const updatedMetadata = {
              ...message.metadata,
              editHistory: newEditHistory,
              currentEditIndex: newEditIndex,
              createdAt:
                message.metadata?.createdAt || new Date().toISOString(),
            };
            const updatedMessage: WorkflowUIMessage = {
              ...message,
              parts: updatedParts,
              metadata: updatedMetadata,
            };

            // Optimistic UI update (truncate later messages, show edited content)
            setMessages((messages) => {
              const index = messages.findIndex((m) => m.id === message.id);
              if (index !== -1) {
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
              // Pass metadata explicitly in the request body — no dependency on
              // useChat's internal message state, so no race condition.
              await regenerate({
                messageId,
                body: {
                  input: {
                    parts: updatedParts,
                    metadata: updatedMetadata,
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
