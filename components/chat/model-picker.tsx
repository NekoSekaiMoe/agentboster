'use client';

import { Check, ChevronsUpDown } from 'lucide-react';
import { useMemo } from 'react';

import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const MAX_VISIBLE_MODELS = 40;

/**
 * Pill-shaped model selector that lives inside the chat composer.
 *
 * Renders a ghost Button with `rounded-full` (pill) showing either the
 * currently selected model id or the "Use global default" label. Clicking
 * opens a DropdownMenu listing every entry in `allowedModels`, plus a
 * synthetic top entry for "Use global default" (selected when
 * `selectedModel === null`).
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

  const triggerLabel = selectedModel
    ? selectedModel
    : t('chat.modelPicker.useDefault');

  const isOpenEntry = !selectedModel || !allowedModels.includes(selectedModel);

  const isDisabled = allowedModels.length === 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="h-9 gap-1 rounded-full px-3"
          disabled={isDisabled}
          size="sm"
          type="button"
          variant="ghost"
        >
          <span className="max-w-[160px] truncate text-xs">{triggerLabel}</span>
          <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" collisionPadding={8} side="top">
        <DropdownMenuItem
          className="gap-2"
          onSelect={() => onSelectModel(null)}
        >
          <span className="flex-1 truncate">
            {t('chat.modelPicker.useDefault')}
          </span>
          {selectedModel === null ? (
            <Check className="size-4 shrink-0" />
          ) : null}
        </DropdownMenuItem>

        {visibleModels.map((modelId) => (
          <DropdownMenuItem
            key={modelId}
            className="gap-2"
            onSelect={() => onSelectModel(modelId)}
          >
            <span className="flex-1 truncate font-mono text-xs">{modelId}</span>
            {selectedModel === modelId ? (
              <Check className="size-4 shrink-0" />
            ) : null}
          </DropdownMenuItem>
        ))}

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
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              {selectedModel}
            </DropdownMenuLabel>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
