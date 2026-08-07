'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Pause, Play, Volume2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface AudioPlayerProps {
  /** Text to synthesize. Empty string disables the button. */
  text: string;
  /** Optional className for the trigger button. */
  className?: string;
  /** If true, start playing on mount (used by auto-play). */
  autoPlay?: boolean;
  /** Called when playback starts. */
  onPlayStart?: () => void;
  /** Called when playback ends or is interrupted. */
  onPlayEnd?: () => void;
}

/**
 * Lazy-fetching audio player. Renders a play/pause button that, on
 * first click, POSTs the text to /api/ai/tts and pipes the response
 * into a hidden <audio> element. Subsequent clicks play/pause the
 * buffered audio without re-fetching.
 *
 * The component is intentionally minimal — no scrubber, no volume —
 * to match the rest of the message action bar.
 */
export function AudioPlayer({
  text,
  className,
  autoPlay,
  onPlayStart,
  onPlayEnd,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const startedRef = useRef(false);
  const lastTextRef = useRef(text);

  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanup = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute('src');
      audioRef.current.load();
    }
    setPlaying(false);
    startedRef.current = false;
  }, []);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  // If text changes (e.g. regenerate), reset.
  useEffect(() => {
    if (lastTextRef.current === text) return;
    lastTextRef.current = text;
    cleanup();
    setError(null);
  }, [text, cleanup]);

  const fetchAudio = useCallback(async (): Promise<string | null> => {
    const res = await fetch('/api/ai/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.error) message = body.error;
      } catch {
        // ignore parse failure
      }
      throw new Error(message);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    return url;
  }, [text]);

  const startPlayback = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    el.play().catch((err: Error) => {
      setError(err.message || 'Playback failed');
      setPlaying(false);
    });
  }, []);

  const handleToggle = useCallback(async () => {
    if (error) setError(null);

    // First play: fetch.
    if (!objectUrlRef.current && !loading) {
      setLoading(true);
      try {
        const url = await fetchAudio();
        if (!url) return;
        objectUrlRef.current = url;
        const el = audioRef.current ?? new Audio();
        el.src = url;
        el.onplay = () => {
          setPlaying(true);
          onPlayStart?.();
        };
        el.onpause = () => {
          setPlaying(false);
        };
        el.onended = () => {
          setPlaying(false);
          onPlayEnd?.();
        };
        el.onerror = () => {
          setError('Audio element error');
          setPlaying(false);
          onPlayEnd?.();
        };
        audioRef.current = el;
        setLoading(false);
        startPlayback();
      } catch (err) {
        setLoading(false);
        setError(err instanceof Error ? err.message : 'TTS fetch failed');
      }
      return;
    }

    // Subsequent toggles: play or pause.
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
    } else {
      startPlayback();
    }
  }, [
    error,
    loading,
    fetchAudio,
    startPlayback,
    playing,
    onPlayStart,
    onPlayEnd,
  ]);

  // Auto-play hook.
  useEffect(() => {
    if (!autoPlay || startedRef.current) return;
    if (!text) return;
    startedRef.current = true;
    handleToggle();
  }, [autoPlay, text, handleToggle]);

  return (
    <>
      <audio ref={audioRef} hidden preload="auto" />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn('gap-1.5', className)}
        onClick={handleToggle}
        disabled={!text || loading}
        title={error ?? (playing ? 'Pause' : 'Play')}
        aria-label={playing ? 'Pause audio' : 'Play audio'}
      >
        {loading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : playing ? (
          <Pause className="size-3.5" />
        ) : (
          <Play className="size-3.5" />
        )}
        <Volume2 className="size-3.5 opacity-60" />
        {error ? (
          <span className="text-destructive text-xs">{error}</span>
        ) : null}
      </Button>
    </>
  );
}
