'use client';

import { useEffect, useRef } from 'react';

import type { WorkflowUIMessage } from '@/types/workflow';

const STORAGE_KEY = 'chat:tts_autoplay';

/**
 * Read the per-session TTS auto-play toggle from localStorage. The
 * default is seeded from chat.tts_autoplay when the user has never
 * explicitly toggled. Returns false when localStorage is unavailable
 * (e.g. SSR or privacy mode).
 */
export function readTtsAutoplay(defaultFromConfig?: boolean): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored !== null) return stored === 'true';
  } catch {
    // ignore
  }
  return Boolean(defaultFromConfig);
}

export function writeTtsAutoplay(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // ignore
  }
}

/**
 * Returns the plain text content of an assistant UI message, joining
 * all `text` parts. Used as TTS input.
 */
export function getAssistantMessageText(message: WorkflowUIMessage): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

interface TtsAutoplayOptions {
  messages: WorkflowUIMessage[];
  status: 'submitted' | 'streaming' | 'ready' | 'error' | 'awaiting-approval';
  enabled: boolean;
  onPlay: (text: string, messageId: string) => void;
}

/**
 * Fires `onPlay(text, messageId)` when the most recent assistant
 * message finishes streaming AND auto-play is enabled. Intermediate
 * 'submitted'/'streaming' states are ignored — the user only hears
 * the final result.
 *
 * Only the LAST assistant message triggers playback; older messages
 * are silent unless the user clicks their per-message play button.
 */
export function useTtsAutoplay(options: TtsAutoplayOptions) {
  const { messages, status, enabled, onPlay } = options;
  const lastPlayedIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (status !== 'ready') return;

    // Find the latest assistant message.
    let lastAssistant: WorkflowUIMessage | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        lastAssistant = messages[i];
        break;
      }
    }
    if (!lastAssistant) return;

    const text = getAssistantMessageText(lastAssistant);
    if (!text) return;
    if (lastPlayedIdRef.current === lastAssistant.id) return;

    lastPlayedIdRef.current = lastAssistant.id;
    onPlay(text, lastAssistant.id);
  }, [messages, status, enabled, onPlay]);
}
