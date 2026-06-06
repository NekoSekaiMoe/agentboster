'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronRight, Sparkles } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';
import type { WorkflowUIMessage } from '@/types/workflow';

export function getReasoningParts(
  message: WorkflowUIMessage,
): Array<{ text: string }> {
  return message.parts.flatMap((part) => {
    if (
      part.type !== 'reasoning' ||
      typeof part.text !== 'string' ||
      part.text.trim().length === 0
    ) {
      return [];
    }

    return [{ text: part.text }];
  });
}

export function ReasoningTimeline({
  parts,
}: {
  parts: Array<{ text: string }>;
  isLast?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const [expandedReasoningParts, setExpandedReasoningParts] = useState<
    Record<number, boolean>
  >({});

  if (parts.length === 0) {
    return null;
  }

  const detailsTransition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.18, ease: [0.22, 1, 0.36, 1] };

  return (
    <div className="space-y-2">
      {parts.map((part, index) => {
        const isExpanded = expandedReasoningParts[index] ?? false;
        const detailsId = `reasoning-details-${index}`;

        return (
          <div key={`reasoning-${index + 1}`} className="min-w-0">
            <button
              type="button"
              aria-expanded={isExpanded}
              aria-controls={detailsId}
              onClick={() => {
                setExpandedReasoningParts((current) => ({
                  ...current,
                  [index]: !isExpanded,
                }));
              }}
              className="-mx-1 inline-flex max-w-full cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left text-foreground/70 text-sm leading-6 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <Sparkles className="size-3.5 shrink-0 text-[#6d9ec3]" />
              <span className="min-w-0 truncate">思考过程</span>
              <ChevronRight
                className={cn(
                  'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none',
                  isExpanded && 'rotate-90',
                )}
              />
            </button>

            <AnimatePresence initial={false}>
              {isExpanded ? (
                <motion.div
                  id={detailsId}
                  initial={{
                    height: 0,
                    opacity: 0,
                    y: reduceMotion ? 0 : -4,
                  }}
                  animate={{ height: 'auto', opacity: 1, y: 0 }}
                  exit={{
                    height: 0,
                    opacity: 0,
                    y: reduceMotion ? 0 : -4,
                  }}
                  transition={detailsTransition}
                  className="overflow-hidden"
                >
                  <div className="mt-2 ml-6 rounded-lg border border-border/50 bg-muted/20 px-3 py-3">
                    <div className="whitespace-pre-wrap break-words text-foreground/80 text-sm leading-6">
                      {part.text}
                    </div>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}
