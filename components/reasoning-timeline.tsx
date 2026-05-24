'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useState } from 'react';

import { cn } from '@/lib/utils';
import type { WorkflowUIMessage } from '@/types/workflow';
import { ChevronDownIcon } from './icons';

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
  isLast = true,
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

  const tone = {
    badge:
      'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    card: '',
    dot: 'bg-amber-500',
  };

  return (
    <div className="space-y-0">
      {parts.map((part, index) => {
        const isExpanded = expandedReasoningParts[index] ?? false;
        const detailsId = `reasoning-details-${index}`;
        const isLastItem = isLast && index === parts.length - 1;

        return (
          <div
            key={`reasoning-${index + 1}`}
            className="grid grid-cols-[20px_minmax(0,1fr)] gap-3"
          >
            <div className="flex h-full flex-col items-center">
              <span
                className={cn(
                  'mt-4 size-2.5 rounded-full border-2 border-background shadow-sm',
                  tone.dot,
                )}
              />
              {!isLastItem ? (
                <span className="mt-2 w-px flex-1 bg-border/80" />
              ) : null}
            </div>

            <div className={cn(!isLastItem && 'pb-4')}>
              <div
                className={cn(
                  'overflow-hidden rounded-[1.25rem] border border-border/70 bg-background/90 shadow-sm',
                  tone.card,
                )}
              >
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
                  className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold leading-5 text-foreground">
                      Reasoning
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2 pl-2">
                    <span
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em]',
                        tone.badge,
                      )}
                    >
                      {isExpanded ? 'Expanded' : 'Collapsed'}
                    </span>
                    <span
                      className={cn(
                        'text-muted-foreground transition-transform duration-200 motion-reduce:transition-none',
                        isExpanded && 'rotate-180',
                      )}
                    >
                      <ChevronDownIcon size={14} />
                    </span>
                  </div>
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
                      <div className="border-t border-border/60 bg-muted/10 px-4 pb-4 pt-3">
                        <div className="text-sm leading-6 text-foreground/80 whitespace-pre-wrap break-words">
                          {part.text}
                        </div>
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
