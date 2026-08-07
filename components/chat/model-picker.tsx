'use client';

import { Check, ChevronDown } from 'lucide-react';
import { useMemo } from 'react';

import { useI18n } from '@/components/i18n-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { parseModelDisplay } from '@/lib/utils/model-display';

const MAX_VISIBLE_MODELS = 40;

/**
 * Gemini-style model selector that lives in the chat header.
 *
 * The trigger shows the current selection as two spans —
 * `[provider][model]` — with the provider emphasized (foreground in light
 * mode, white in dark mode) and the formatted model name muted. Clicking
 * opens a list of formatted model names (no descriptions, no reasoning
 * tiers) with a check mark on the selected entry, plus a synthetic top
 * entry for "Use global default" (selected when `selectedModel === null`).
 *
 * When `allowedModels` is empty the picker is disabled — this happens
 * before the initial fetch completes or if the admin catalog and the
 * fallback provider list are both empty.
 *
 * Selection of a model not in `allowedModels` (E.1 fallback): the trigger
 * still shows the model id, but no check mark appears in the list. The
 * server still accepts the id (free-form input is honored end-to-end).
 */
export function ModelPicker({
  selectedModel,
  allowedModels,
  onSelectModel,
}: {
  selectedModel: string | null;
  allowedModels: string[];
  onSelectModel: (model: string | null) => void;
}) {
  const { t } = useI18n();

  const visibleModels = useMemo(
    () =>
      [...allowedModels]
        .sort((a, b) => a.localeCompare(b))
        .slice(0, MAX_VISIBLE_MODELS),
    [allowedModels],
  );

  const display = selectedModel ? parseModelDisplay(selectedModel) : null;

  const isOpenEntry = !selectedModel || !allowedModels.includes(selectedModel);

  const isDisabled = allowedModels.length === 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isDisabled}
          type="button"
        >
          {display ? (
            <span className="flex min-w-0 items-baseline gap-1.5 text-lg tracking-tight">
              {display.provider ? (
                <span className="shrink-0 font-semibold text-foreground">
                  {display.provider}
                </span>
              ) : null}
              <span className="truncate text-muted-foreground">
                {display.model}
              </span>
            </span>
          ) : (
            <span className="truncate text-lg text-muted-foreground tracking-tight">
              {t('chat.modelPicker.useDefault')}
            </span>
          )}
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[260px] rounded-2xl p-2"
        collisionPadding={8}
        side="bottom"
      >
        <DropdownMenuItem
          className="gap-2 rounded-lg px-2 py-2.5"
          onSelect={() => onSelectModel(null)}
        >
          <span className="flex size-5 shrink-0 items-center justify-center">
            {selectedModel === null ? <Check className="size-4" /> : null}
          </span>
          <span className="flex-1 truncate text-base">
            {t('chat.modelPicker.useDefault')}
          </span>
        </DropdownMenuItem>

        {visibleModels.map((modelId) => {
          const item = parseModelDisplay(modelId);
          return (
            <DropdownMenuItem
              key={modelId}
              className="gap-2 rounded-lg px-2 py-2.5"
              onSelect={() => onSelectModel(modelId)}
            >
              <span className="flex size-5 shrink-0 items-center justify-center">
                {selectedModel === modelId ? (
                  <Check className="size-4" />
                ) : null}
              </span>
              <span className="flex-1 truncate text-base">{item.model}</span>
            </DropdownMenuItem>
          );
        })}

        {allowedModels.length > MAX_VISIBLE_MODELS ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              {t('chat.modelPicker.moreAvailable', {
                count: allowedModels.length - MAX_VISIBLE_MODELS,
              })}
            </DropdownMenuLabel>
          </>
        ) : null}

        {selectedModel && isOpenEntry ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="truncate text-muted-foreground text-xs">
              {selectedModel}
            </DropdownMenuLabel>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
