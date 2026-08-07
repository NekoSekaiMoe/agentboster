'use client';

import type { ChatRequestOptions, CreateUIMessage } from 'ai';
import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useLocalStorage, useWindowSize } from 'usehooks-ts';

import {
  AttachmentList,
  type AttachmentUploadProgress,
  type ComposerAttachment,
  buildAttachmentId,
  fileToComposerAttachment,
} from '@/components/attachments';
import { ArrowUp, Mic, Plus, Square } from 'lucide-react';
import {
  MentionMenu,
  applyMention,
  getMentionMatch,
  useMentionNavigation,
} from '@/components/chat/mention-menu';
import {
  SlashCommandMenu,
  applySlashCommand,
  getSlashCommandMatch,
  useSlashCommandNavigation,
} from '@/components/slash-command-menu';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { UserMessagePart, WorkflowUIMessage } from '@/types/workflow';

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
    ref.current.style.height = '44px';
  }
};

function PureMultimodalInput({
  chatId,
  focusTrigger = 0,
  input,
  setInput,
  isLoading,
  enterToSend,
  stop,
  sendMessage,
  className,
  selectedModel,
  selectedAgent,
}: {
  chatId: string;
  focusTrigger?: number;
  input: string;
  setInput: (value: string) => void;
  isLoading: boolean;
  enterToSend: boolean;
  stop: () => void;
  sendMessage: (
    message?: ComposerMessage,
    options?: ChatRequestOptions,
  ) => Promise<void>;
  className?: string;
  /** Currently selected model id, sent in the request body (null = global default). Selection UI lives in the chat header. */
  selectedModel: string | null;
  /** Currently selected persona (agentName), sent in the request body (null = 'main'). Selection UI lives in the chat header. */
  selectedAgent: string | null;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { width } = useWindowSize();
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [uploadProgress, setUploadProgress] = useState<
    AttachmentUploadProgress[]
  >([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const [cursor, setCursor] = useState(0);
  const hasHydratedInputRef = useRef(false);

  const [isRecording, setIsRecording] = useState(false);
  // biome-ignore lint/suspicious/noExplicitAny: Web Speech API types are not fully available
  const recognitionRef = useRef<any>(null);
  const startInputRef = useRef<string>('');
  const pendingVoiceSubmitRef = useRef(false);
  const [shouldSubmit, setShouldSubmit] = useState(false);

  const toggleRecording = useCallback(() => {
    // Web Speech API types are not in TS's lib.dom yet; access defensively.
    // The recognition instance is loosely typed because the full event
    // handler API isn't covered by lib.dom.
    type SpeechRecognitionCtor = new () => {
      continuous: boolean;
      interimResults: boolean;
      lang: string;
      start: () => void;
      stop: () => void;
      onstart: (() => void) | null;
      onend: (() => void) | null;
      onerror: ((e: unknown) => void) | null;
      onresult: ((e: unknown) => void) | null;
    };
    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const SpeechRecognition = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toast.error('Voice input is not supported in this browser.');
      return;
    }

    if (recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;

    startInputRef.current = input;
    let currentFinal = '';

    recognition.onstart = () => {
      setIsRecording(true);
    };

    // biome-ignore lint/suspicious/noExplicitAny: Web Speech API types are not fully available
    recognition.onresult = (event: any) => {
      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }

      currentFinal += final;
      const space =
        startInputRef.current && (currentFinal || interim) ? ' ' : '';
      setInput(startInputRef.current + space + currentFinal + interim);

      requestAnimationFrame(() => {
        adjustHeight(textareaRef);
      });
    };

    // biome-ignore lint/suspicious/noExplicitAny: Web Speech API types are not fully available
    recognition.onerror = (event: any) => {
      console.error('Speech recognition error', event.error);
      setIsRecording(false);
      recognitionRef.current = null;
    };

    recognition.onend = () => {
      setIsRecording(false);
      recognitionRef.current = null;
      if (pendingVoiceSubmitRef.current) {
        pendingVoiceSubmitRef.current = false;
        setShouldSubmit(true);
      }
    };

    recognition.start();
    recognitionRef.current = recognition;
  }, [input, setInput]);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, []);

  useEffect(() => {
    if (textareaRef.current) {
      adjustHeight(textareaRef);
    }
  }, []);

  useEffect(() => {
    if (width && width > 768) {
      textareaRef.current?.focus();
    }
  }, [width]);

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

  const insertMention = useCallback(
    (token: string) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const match = getMentionMatch(input, cursor);
      if (!match) return;
      const { nextValue, nextCursor } = applyMention(input, match, token);
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

  // Recent attachment names flow into the @ menu as suggestions so the
  // user can quickly re-reference something they just dragged in.
  const mentionAttachments = useMemo(
    () => attachments.map((a) => ({ name: a.name })),
    [attachments],
  );
  const mentions = useMentionNavigation(
    input,
    cursor,
    mentionAttachments,
    insertMention,
  );

  const addFiles = useCallback(async (files: FileList | File[]) => {
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
  }, []);

  const removeAttachment = useCallback((attachmentId: string) => {
    setAttachments((current) =>
      current.filter((attachment) => attachment.id !== attachmentId),
    );
  }, []);

  const submitForm = useCallback(async () => {
    if (uploadProgress.length > 0) return;
    if (!input.trim() && attachments.length === 0) return;

    if (recognitionRef.current) {
      pendingVoiceSubmitRef.current = true;
      recognitionRef.current.stop();
      return;
    }

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
    setUploadProgress(
      attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        loaded: attachment.size,
        total: attachment.size,
        status: 'processing',
      })),
    );
    setAttachments([]);
    resetHeight(textareaRef);

    try {
      await sendMessage(
        {
          parts: nextParts,
        },
        {
          body: {
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(selectedAgent ? { agent: selectedAgent } : {}),
          },
        },
      );

      if (width && width > 768) {
        textareaRef.current?.focus();
      }
      setUploadProgress([]);
    } catch (error) {
      window.history.replaceState({}, '', previousUrl);
      setInput(previousInput);
      setLocalStorageInput(previousInput);
      setAttachments(previousAttachments);
      setUploadProgress([]);
      adjustHeight(textareaRef);
      toast.error(
        error instanceof Error ? error.message : 'Failed to send message.',
      );
    }
  }, [
    attachments,
    chatId,
    input,
    selectedModel,
    selectedAgent,
    sendMessage,
    setInput,
    setLocalStorageInput,
    uploadProgress.length,
    width,
  ]);

  useEffect(() => {
    if (shouldSubmit) {
      setShouldSubmit(false);
      void submitForm();
    }
  }, [shouldSubmit, submitForm]);

  return (
    <div className="relative flex w-full flex-col gap-2">
      <input
        type="file"
        ref={fileInputRef}
        multiple
        aria-label="Attach files"
        className="pointer-events-none fixed -top-4 -left-4 size-0.5 opacity-0"
        tabIndex={-1}
        onChange={(event) => {
          if (event.target.files) {
            void addFiles(event.target.files);
            event.target.value = '';
          }
        }}
      />

      <AttachmentList
        attachments={attachments}
        uploadProgress={uploadProgress}
        onRemove={removeAttachment}
      />

      <div
        role="group"
        aria-label="Message composer"
        className={cn(
          'relative flex flex-row items-end gap-1 rounded-full bg-card p-2 ring-1 ring-black/[0.06]',
          'shadow-[0_1px_3px_rgba(15,23,42,0.08),0_10px_28px_-8px_rgba(15,23,42,0.18),0_28px_64px_-20px_rgba(15,23,42,0.16),inset_0_1px_0_rgba(255,255,255,0.7)]',
          'transition-[background-color,box-shadow,transform] duration-200',
          'focus-within:-translate-y-0.5 focus-within:shadow-[0_2px_5px_rgba(15,23,42,0.1),0_16px_36px_-10px_rgba(15,23,42,0.24),0_36px_80px_-24px_rgba(15,23,42,0.2),inset_0_1px_0_rgba(255,255,255,0.8)]',
          'dark:shadow-[0_1px_3px_rgba(0,0,0,0.5),0_12px_32px_-8px_rgba(0,0,0,0.7),0_32px_72px_-20px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.08)] dark:ring-white/[0.08]',
          'dark:focus-within:shadow-[0_2px_6px_rgba(0,0,0,0.55),0_18px_40px_-10px_rgba(0,0,0,0.78),0_40px_88px_-24px_rgba(0,0,0,0.68),inset_0_1px_0_rgba(255,255,255,0.12)]',
          {
            'bg-primary/5 ring-2 ring-primary/50': isDragActive,
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
        <SlashCommandMenu
          value={input}
          cursor={cursor}
          activeIndex={slashCommands.activeIndex}
          onActiveIndexChange={slashCommands.setActiveIndex}
          onSelect={insertSlashCommand}
        />

        <MentionMenu
          value={input}
          cursor={cursor}
          activeIndex={mentions.activeIndex}
          recentAttachments={mentionAttachments}
          onSelect={insertMention}
        />

        <button
          aria-label="Add attachments"
          className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={(event) => {
            event.preventDefault();
            fileInputRef.current?.click();
          }}
          type="button"
        >
          <Plus className="size-5" />
        </button>

        <Textarea
          ref={textareaRef}
          placeholder="Ask anything"
          value={input}
          onChange={handleInput}
          style={{
            border: 'none',
            background: 'transparent',
            outline: 'none',
            boxShadow: 'none',
            WebkitAppearance: 'none',
            appearance: 'none',
          }}
          className="!text-base !border-none !bg-transparent !shadow-none !outline-none focus:!outline-none focus:!ring-0 focus-visible:!ring-0 focus-visible:!outline-none max-h-[50dvh] min-h-11 min-w-0 flex-1 resize-none overflow-hidden px-2 py-2.5"
          rows={1}
          autoFocus={false}
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
            if (mentions.onKeyDown(event)) {
              return;
            }

            const shouldSubmit =
              event.key === 'Enter' &&
              (enterToSend ? !event.shiftKey : event.shiftKey);

            if (shouldSubmit) {
              event.preventDefault();
              void submitForm();
            }
          }}
        />

        <div className="flex shrink-0 flex-row items-center justify-end gap-2">
          {isLoading ? (
            <StopButton stop={stop} />
          ) : input.trim().length === 0 && attachments.length === 0 ? (
            <RecordButton
              isRecording={isRecording}
              toggleRecording={toggleRecording}
              isUploading={uploadProgress.length > 0}
            />
          ) : (
            <SendButton
              input={input}
              hasAttachments={attachments.length > 0}
              isUploading={uploadProgress.length > 0}
              submitForm={submitForm}
            />
          )}
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
    if (prevProps.enterToSend !== nextProps.enterToSend) return false;
    if (prevProps.selectedModel !== nextProps.selectedModel) return false;
    if (prevProps.selectedAgent !== nextProps.selectedAgent) return false;

    return true;
  },
);

function PureStopButton({ stop }: { stop: () => void }) {
  return (
    <Button
      aria-label="Stop generating"
      className="size-11 rounded-full bg-transparent p-0 text-muted-foreground shadow-none hover:bg-muted hover:text-foreground"
      onClick={(event) => {
        event.preventDefault();
        stop();
      }}
      variant="ghost"
    >
      <Square className="size-5 fill-current" />
    </Button>
  );
}

const StopButton = memo(PureStopButton);

function PureSendButton({
  submitForm,
  input,
  hasAttachments,
  isUploading,
}: {
  submitForm: () => Promise<void>;
  input: string;
  hasAttachments: boolean;
  isUploading: boolean;
}) {
  return (
    <Button
      aria-label="Send message"
      className="size-11 rounded-full bg-transparent p-0 text-muted-foreground shadow-none hover:bg-muted hover:text-foreground disabled:opacity-40"
      data-testid="send-button"
      onClick={(event) => {
        event.preventDefault();
        void submitForm();
      }}
      disabled={isUploading || (input.trim().length === 0 && !hasAttachments)}
      variant="ghost"
    >
      <ArrowUp className="size-5" />
    </Button>
  );
}

const SendButton = memo(PureSendButton, (prevProps, nextProps) => {
  if (prevProps.input !== nextProps.input) return false;
  if (prevProps.hasAttachments !== nextProps.hasAttachments) return false;
  if (prevProps.isUploading !== nextProps.isUploading) return false;
  return true;
});

function PureRecordButton({
  isRecording,
  toggleRecording,
  isUploading,
}: {
  isRecording: boolean;
  toggleRecording: () => void;
  isUploading: boolean;
}) {
  return (
    <Button
      aria-label={isRecording ? 'Stop recording' : 'Start voice input'}
      className={cn(
        'size-11 rounded-full bg-transparent p-0 text-muted-foreground shadow-none hover:bg-muted hover:text-foreground disabled:opacity-40',
        isRecording
          ? 'text-red-500 hover:bg-red-500/10 hover:text-red-500'
          : '',
      )}
      onClick={(event) => {
        event.preventDefault();
        toggleRecording();
      }}
      disabled={isUploading}
      title={isRecording ? 'Stop recording' : 'Start voice input'}
      variant="ghost"
    >
      {isRecording ? (
        <Square className="size-5 fill-current" />
      ) : (
        <Mic className="size-5" />
      )}
    </Button>
  );
}

const RecordButton = memo(PureRecordButton, (prevProps, nextProps) => {
  if (prevProps.isRecording !== nextProps.isRecording) return false;
  if (prevProps.isUploading !== nextProps.isUploading) return false;
  if (prevProps.toggleRecording !== nextProps.toggleRecording) return false;
  return true;
});
