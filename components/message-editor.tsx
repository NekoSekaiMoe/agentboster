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
  sessionId: string;
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
  sessionId,
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

            // Capture current assistant response parts so switching back to
            // a previous edit version also restores the matching response.
            // We snapshot inside setMessages (which has the full message list)
            // below — here we just prepare the user-side parts.
            const messageCreatedAt =
              message.metadata?.createdAt || new Date().toISOString();

            // Optimistic UI update (truncate later messages, show edited content).
            // Done inside setMessages so we can also snapshot the assistant reply.
            setMessages((messages) => {
              const index = messages.findIndex((m) => m.id === message.id);
              if (index === -1) return messages;

              // Find the assistant message right after this user message
              let assistantResponseParts:
                | Array<
                    | { type: 'text'; text: string }
                    | {
                        type: 'file';
                        filename?: string;
                        mediaType: string;
                        url: string;
                        providerMetadata?: unknown;
                      }
                  >
                | undefined;
              for (let i = index + 1; i < messages.length; i++) {
                if (messages[i].role === 'assistant') {
                  assistantResponseParts = messages[i].parts
                    .filter((p) => p.type === 'text' || p.type === 'file')
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
                  break;
                }
              }

              let newEditHistory = editHistory;
              let newEditIndex = currentEditIndex;

              if (contentChanged) {
                if (editHistory.length === 0) {
                  // First edit: snapshot original user parts + assistant reply
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
                      responseParts: assistantResponseParts,
                      createdAt: messageCreatedAt,
                    },
                    {
                      parts: updatedParts,
                      createdAt: new Date().toISOString(),
                    },
                  ];
                  newEditIndex = newEditHistory.length - 1;
                } else {
                  // Subsequent edit: attach assistant reply to the CURRENT
                  // version (before truncation), then append the new version.
                  if (currentEditIndex < newEditHistory.length - 1) {
                    newEditHistory = newEditHistory.slice(
                      0,
                      currentEditIndex + 1,
                    );
                  }

                  // Attach the captured assistant response to the entry at
                  // currentEditIndex (which is the version the user was viewing).
                  if (
                    assistantResponseParts &&
                    newEditHistory[currentEditIndex]
                  ) {
                    newEditHistory = newEditHistory.map((entry, i) =>
                      i === currentEditIndex
                        ? { ...entry, responseParts: assistantResponseParts }
                        : entry,
                    );
                  }

                  newEditHistory = [
                    ...newEditHistory,
                    {
                      parts: updatedParts,
                      createdAt: new Date().toISOString(),
                    },
                  ];
                  newEditIndex = newEditHistory.length - 1;
                }
              }

              const updatedMetadata = {
                ...message.metadata,
                editHistory: newEditHistory,
                currentEditIndex: newEditIndex,
                createdAt: messageCreatedAt,
              };

              const updatedMessage: WorkflowUIMessage = {
                ...message,
                parts: updatedParts,
                metadata: updatedMetadata,
              };

              return [
                ...messages.slice(0, index),
                updatedMessage,
                ...messages.slice(index + 1),
              ];
            });

            setMode('view');

            // Persist the updated metadata (including responseParts) so it
            // survives page refresh and is available when switching versions.
            try {
              // Read the latest metadata from the just-updated message
              let metadataToPersist: WorkflowUIMessage['metadata'] | undefined;
              setMessages((msgs) => {
                const m = msgs.find((x) => x.id === message.id);
                if (m) metadataToPersist = m.metadata;
                return msgs;
              });

              if (metadataToPersist) {
                await fetch(`/api/messages/${messageId}/metadata`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    sessionId,
                    metadata: metadataToPersist,
                  }),
                });
              }

              // Now regenerate — backend will load metadata from database
              await regenerate({
                messageId,
                body: {
                  input: {
                    parts: updatedParts,
                  },
                },
              });

              // After regenerate completes, attach the NEW assistant reply
              // to the current edit version so it shows up when switching
              // back to this version later.
              setMessages((msgs) => {
                const userIdx = msgs.findIndex((m) => m.id === message.id);
                if (userIdx === -1) return msgs;

                // Find the new assistant message
                let assistantIdx = -1;
                for (let i = userIdx + 1; i < msgs.length; i++) {
                  if (msgs[i].role === 'assistant') {
                    assistantIdx = i;
                    break;
                  }
                }
                if (assistantIdx === -1) return msgs;

                const newResponseParts = msgs[assistantIdx].parts
                  .filter((p) => p.type === 'text' || p.type === 'file')
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

                const userMsg = msgs[userIdx];
                const hist = userMsg.metadata?.editHistory || [];
                const curIdx = userMsg.metadata?.currentEditIndex ?? 0;

                if (curIdx < 0 || curIdx >= hist.length) return msgs;

                const updatedHist = hist.map((entry, i) =>
                  i === curIdx
                    ? { ...entry, responseParts: newResponseParts }
                    : entry,
                );

                const updatedMeta = {
                  ...userMsg.metadata,
                  editHistory: updatedHist,
                };

                // Persist the updated history with responseParts
                if (sessionId) {
                  fetch(`/api/messages/${message.id}/metadata`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      sessionId,
                      metadata: updatedMeta,
                    }),
                  }).catch(() => {});
                }

                return [
                  ...msgs.slice(0, userIdx),
                  { ...userMsg, metadata: updatedMeta },
                  ...msgs.slice(userIdx + 1),
                ];
              });
            } catch (error) {
              if (process.env.NODE_ENV === 'development') {
                console.error('[message-editor] Error:', error);
              }
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
