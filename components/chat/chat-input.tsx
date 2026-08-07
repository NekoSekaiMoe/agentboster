'use client';

import type { ChatRequestOptions, CreateUIMessage } from 'ai';
import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useLocalStorage, useWindowSize } from 'usehooks-ts';

import {
  AttachmentButton,
  AttachmentList,
  type AttachmentUploadProgress,
  type ComposerAttachment,
  buildAttachmentId,
  fileToComposerAttachment,
} from '@/components/attachments';
import { ArrowUpIcon, StopIcon } from '@/components/icons';
import { ModelPicker } from '@/components/chat/model-picker';
import { PersonaPicker } from '@/components/chat/persona-picker';
import { Mic } from 'lucide-react';
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
    ref.current.style.height = '56px';
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
  allowedModels,
  onSelectModel,
  selectedAgent,
  onSelectAgent,
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
  /** Currently selected model id from the chat-box picker, or null for global default. */
  selectedModel: string | null;
  /** Models the user is allowed to pick (admin catalog or fallback). Empty list disables the picker. */
  allowedModels: string[];
  /** Called when the user picks a model (or null for "Use global default"). */
  onSelectModel: (model: string | null) => void;
  /** Currently selected persona (agentName) for the picker. null = 'main'. */
  selectedAgent: string | null;
  /** Called when the user picks a persona (null for the Default persona). */
  onSelectAgent: (agent: string | null) => void;
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
    <div className="relative flex w-full flex-col gap-4">
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

      <div
        role="group"
        aria-label="Message composer"
        className={cn(
          'relative flex flex-col gap-3 rounded-[32px] bg-background/95 px-4 py-4',
          'shadow-[0_1px_2px_rgba(0,0,0,0.05),0_12px_32px_-12px_rgba(0,0,0,0.22),0_32px_64px_-24px_rgba(0,0,0,0.16),inset_0_1px_0_rgba(255,255,255,0.5)] backdrop-blur-xl',
          'transition-[background-color,box-shadow,transform] duration-200',
          'focus-within:-translate-y-0.5 focus-within:bg-background focus-within:shadow-[0_2px_4px_rgba(0,0,0,0.06),0_20px_44px_-14px_rgba(0,0,0,0.28),0_40px_80px_-28px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.6)]',
          'dark:bg-background/80 dark:shadow-[0_1px_2px_rgba(0,0,0,0.4),0_16px_40px_-12px_rgba(0,0,0,0.7),0_36px_72px_-24px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.08)]',
          'dark:focus-within:shadow-[0_2px_6px_rgba(0,0,0,0.5),0_24px_52px_-14px_rgba(0,0,0,0.78),0_44px_88px_-28px_rgba(0,0,0,0.68),inset_0_1px_0_rgba(255,255,255,0.12)]',
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
        <AttachmentList
          attachments={attachments}
          uploadProgress={uploadProgress}
          onRemove={removeAttachment}
        />

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

        <Textarea
          ref={textareaRef}
          placeholder="Ask AgentBoster..."
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
          className="!text-base !border-none !bg-transparent !shadow-none !outline-none focus:!outline-none focus:!ring-0 focus-visible:!ring-0 focus-visible:!outline-none max-h-[calc(75dvh)] min-h-11 resize-none overflow-hidden px-0 pt-0 pb-12"
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

        <div className="absolute bottom-0 left-0 flex w-fit flex-row items-center gap-2 p-3">
          <PersonaPicker
            onSelectAgent={onSelectAgent}
            selectedAgent={selectedAgent}
          />
          <ModelPicker
            allowedModels={allowedModels}
            onSelectModel={onSelectModel}
            selectedModel={selectedModel}
          />
        </div>

        <div className="absolute right-0 bottom-0 flex w-fit flex-row justify-end gap-2 p-3">
          <AttachmentButton onClick={() => fileInputRef.current?.click()} />
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
    if (prevProps.allowedModels !== nextProps.allowedModels) return false;
    if (prevProps.onSelectModel !== nextProps.onSelectModel) return false;
    if (prevProps.selectedAgent !== nextProps.selectedAgent) return false;
    if (prevProps.onSelectAgent !== nextProps.onSelectAgent) return false;

    return true;
  },
);

function PureStopButton({ stop }: { stop: () => void }) {
  return (
    <Button
      className="size-11 rounded-full border p-0 dark:border-zinc-600"
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
  isUploading,
}: {
  submitForm: () => Promise<void>;
  input: string;
  hasAttachments: boolean;
  isUploading: boolean;
}) {
  return (
    <Button
      className="size-11 rounded-full border p-0 dark:border-zinc-600"
      onClick={(event) => {
        event.preventDefault();
        void submitForm();
      }}
      disabled={isUploading || (input.trim().length === 0 && !hasAttachments)}
    >
      <ArrowUpIcon size={14} />
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
      className={cn(
        'size-11 rounded-full border p-0 transition-colors dark:border-zinc-600',
        isRecording
          ? 'border-red-500 bg-red-500 text-white hover:bg-red-600'
          : '',
      )}
      onClick={(event) => {
        event.preventDefault();
        toggleRecording();
      }}
      disabled={isUploading}
      title={isRecording ? 'Stop recording' : 'Start voice input'}
    >
      {isRecording ? <StopIcon size={14} /> : <Mic size={14} />}
    </Button>
  );
}

const RecordButton = memo(PureRecordButton, (prevProps, nextProps) => {
  if (prevProps.isRecording !== nextProps.isRecording) return false;
  if (prevProps.isUploading !== nextProps.isUploading) return false;
  if (prevProps.toggleRecording !== nextProps.toggleRecording) return false;
  return true;
});
