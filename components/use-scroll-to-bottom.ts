import { type RefObject, useEffect, useRef } from 'react';

export function useScrollToBottom<T extends HTMLElement>(
  trackedItem: unknown,
  secondarySignal: unknown = null,
): [RefObject<T | null>, RefObject<T | null>] {
  const containerRef = useRef<T | null>(null);
  const endRef = useRef<T | null>(null);
  const isPinnedToBottomRef = useRef(true);
  const hasMountedRef = useRef(false);
  const previousTrackedItemRef = useRef<unknown>(null);
  const previousSecondarySignalRef = useRef<unknown>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const updatePinnedState = () => {
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;

      isPinnedToBottomRef.current = distanceFromBottom <= 32;
    };

    updatePinnedState();
    container.addEventListener('scroll', updatePinnedState, { passive: true });

    return () => {
      container.removeEventListener('scroll', updatePinnedState);
    };
  }, []);

  useEffect(() => {
    const end = endRef.current;

    if (!end) {
      return;
    }

    const hasRelevantChange =
      previousTrackedItemRef.current !== trackedItem ||
      previousSecondarySignalRef.current !== secondarySignal;

    previousTrackedItemRef.current = trackedItem;
    previousSecondarySignalRef.current = secondarySignal;

    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }

    if (!hasRelevantChange || !isPinnedToBottomRef.current) {
      return;
    }

    end.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [trackedItem, secondarySignal]);

  return [containerRef, endRef];
}
