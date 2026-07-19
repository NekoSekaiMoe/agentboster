import { type RefObject, useEffect, useRef } from 'react';

const PINNED_TO_BOTTOM_THRESHOLD = 64;

export function useScrollToBottom<T extends HTMLElement>(
  trackedItem: unknown,
  secondarySignal: unknown = null,
  options?: { scrollOnMount?: boolean },
): [RefObject<T | null>, RefObject<T | null>] {
  const containerRef = useRef<T | null>(null);
  const endRef = useRef<T | null>(null);
  const isPinnedToBottomRef = useRef(true);
  const hasMountedRef = useRef(false);
  const previousTrackedItemRef = useRef<unknown>(null);
  const previousSecondarySignalRef = useRef<unknown>(null);
  const touchStartYRef = useRef<number | null>(null);
  const scrollOnMount = options?.scrollOnMount ?? true;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const updatePinnedState = () => {
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;

      isPinnedToBottomRef.current =
        distanceFromBottom <= PINNED_TO_BOTTOM_THRESHOLD;
    };

    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        isPinnedToBottomRef.current = false;
      }
    };

    const handleTouchStart = (event: TouchEvent) => {
      touchStartYRef.current = event.touches[0]?.clientY ?? null;
    };

    const handleTouchMove = (event: TouchEvent) => {
      const startY = touchStartYRef.current;
      const currentY = event.touches[0]?.clientY;

      if (startY == null || currentY == null) {
        return;
      }

      if (currentY - startY > 4) {
        isPinnedToBottomRef.current = false;
      }
    };

    updatePinnedState();
    container.addEventListener('scroll', updatePinnedState, { passive: true });
    container.addEventListener('wheel', handleWheel, { passive: true });
    container.addEventListener('touchstart', handleTouchStart, {
      passive: true,
    });
    container.addEventListener('touchmove', handleTouchMove, {
      passive: true,
    });

    return () => {
      container.removeEventListener('scroll', updatePinnedState);
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
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
      // First mount: pin to the bottom so opening a session shows the
      // latest message. Defer one frame so layout is flushed first.
      hasMountedRef.current = true;

      if (scrollOnMount) {
        isPinnedToBottomRef.current = true;
        const frame = requestAnimationFrame(() => {
          end.scrollIntoView({ behavior: 'instant', block: 'end' });
        });
        return () => cancelAnimationFrame(frame);
      }

      // New session: stay at top, let user scroll manually
      isPinnedToBottomRef.current = false;
      return;
    }

    if (!hasRelevantChange || !isPinnedToBottomRef.current) {
      return;
    }

    end.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [trackedItem, secondarySignal, scrollOnMount]);

  return [containerRef, endRef];
}
