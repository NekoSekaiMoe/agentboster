'use client';

import { memo, useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';

import { ModelPersonaPicker } from '@/components/chat/model-persona-picker';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { LoaderCircle, Square } from 'lucide-react';
import { parseWithFallback } from '@/lib/core/api/schema';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { z } from 'zod';

/**
 * Lenient schema for GET /api/agentd/v1/available. The server returns
 * `{ success, data: { available: boolean } }`; we keep `available` as
 * optional so an unknown/ drifted field shape still parses to `false`
 * rather than white-screening the header.
 */
const agentdAvailableSchema = z.object({
  success: z.boolean().optional(),
  data: z.object({ available: z.boolean().optional() }).optional(),
});

/**
 * Gemini-style chat header: the combined model/persona selector is the
 * title. Everything else from the old header (title, badges, token usage,
 * orchestration link) is gone; the only remaining affordances are a
 * single status dot (agentd availability / running state) and the abort
 * button while a session runs.
 */
function PureChatHeader({
  isRunning,
  chatId,
  onAbort,
  selectedModel,
  allowedModels,
  onSelectModel,
  selectedAgent,
  onSelectAgent,
}: {
  /** True while the assistant is streaming/submitting (drives the status dot + abort button). */
  isRunning: boolean;
  chatId?: string;
  onAbort?: () => void;
  selectedModel: string | null;
  allowedModels: string[];
  onSelectModel: (model: string | null) => void;
  selectedAgent: string | null;
  onSelectAgent: (agent: string | null) => void;
}) {
  const { t } = useI18n();
  const [aborting, setAborting] = useState(false);

  // agentd availability poll. Replaces a hand-rolled useEffect + fetch +
  // setInterval + cancelled-flag with useQuery's refetchInterval. The
  // query is non-blocking for the header: while loading, the status dot
  // shows the muted 'checking' color; once settled it flips to online/
  // offline. parseWithFallback guards against a drifted response shape
  // (installed desktop clients hitting a newer backend) so the header
  // never white-screens.
  const { data: agentdAvailable } = useQuery({
    queryKey: ['agentd', 'available'],
    queryFn: async () => {
      const response = await fetch('/api/agentd/v1/available', {
        cache: 'no-store',
      });
      if (!response.ok) return false;
      const payload = await parseWithFallback(
        await response.json(),
        agentdAvailableSchema,
        { success: false, data: { available: false } },
        { endpoint: 'GET /api/agentd/v1/available' },
      );
      return payload.data?.available === true;
    },
    refetchInterval: 30_000,
    // Treat fetch errors as 'offline' rather than retrying indefinitely —
    // a dead daemon shouldn't hammer the endpoint.
    retry: 1,
    initialData: false,
  });

  const agentdStatus: 'online' | 'offline' | 'checking' = agentdAvailable
    ? 'online'
    : 'offline';

  const handleAbort = useCallback(async () => {
    if (!chatId) return;
    setAborting(true);
    try {
      const response = await fetch(`/api/agentd/v1/sessions/${chatId}/abort`, {
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error('Abort request failed');
      }
      toast.success(t('chatHeader.abortSuccess'));
      onAbort?.();
    } catch {
      toast.error(t('chatHeader.abortError'));
    } finally {
      setAborting(false);
    }
  }, [chatId, onAbort, t]);

  return (
    <header className="sticky top-0 z-20 flex items-center gap-1 border-b bg-background/95 py-2 pr-4 pl-14 backdrop-blur md:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <ModelPersonaPicker
          allowedModels={allowedModels}
          onSelectModel={onSelectModel}
          selectedModel={selectedModel}
          onSelectAgent={onSelectAgent}
          selectedAgent={selectedAgent}
        />
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {/* Single status dot: agentd availability / running indicator */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="flex size-5 items-center justify-center"
              role="img"
              aria-label={
                isRunning
                  ? t('chatHeader.running')
                  : agentdStatus === 'online'
                    ? t('chatHeader.agentdOnlineTitle')
                    : t('chatHeader.agentdOfflineTitle')
              }
            >
              <span
                className={`size-2 rounded-full ${
                  isRunning
                    ? 'animate-pulse bg-amber-500'
                    : agentdStatus === 'online'
                      ? 'bg-green-500'
                      : agentdStatus === 'offline'
                        ? 'bg-amber-500'
                        : 'bg-muted-foreground/40'
                }`}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {isRunning
              ? t('chatHeader.running')
              : agentdStatus === 'online'
                ? t('chatHeader.agentdOnlineTitle')
                : t('chatHeader.agentdOfflineTitle')}
          </TooltipContent>
        </Tooltip>

        {/* Abort button — only when running */}
        {isRunning && chatId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                className="shrink-0 px-2 text-red-600 hover:bg-red-50 hover:text-red-700 md:h-fit"
                aria-label={t('chatHeader.abortSession')}
                onClick={handleAbort}
                disabled={aborting}
              >
                {aborting ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Square className="size-4" fill="currentColor" />
                )}
                <span className="hidden md:inline">
                  {t('chatHeader.abort')}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('chatHeader.abortSession')}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}

export const ChatHeader = memo(PureChatHeader);
