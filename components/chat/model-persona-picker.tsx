'use client';

import { ArrowLeft, Check, ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import {
  listChatPersonasAction,
  type PersonaOption,
} from '@/app/(chat)/actions';
import { useI18n } from '@/components/i18n-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { parseModelDisplay } from '@/lib/utils/model-display';

const MAX_VISIBLE_MODELS = 40;

/**
 * Combined model + persona selector that lives in the chat header (the
 * trigger doubles as the page title).
 *
 * The trigger shows only the formatted model name (no provider prefix —
 * model names already carry the brand). A non-default persona is appended
 * as `· <persona>`; the default persona ('main') adds nothing.
 *
 * The popover is a drill-in panel with two views:
 *  - "models": Gemini-style two-line rows (model name + `Provider: X`
 *    subtitle) with a check mark on the selection, plus a synthetic top
 *    entry for the global default (selected when `selectedModel === null`).
 *    The list scrolls after ~4 rows on mobile and shows nearly the whole
 *    catalog on desktop.
 *  - "personas": reached via the persona row at the bottom (only rendered
 *    when custom personas exist); a back row returns to the model list.
 *    Selecting 'main' maps to null (no override) so the request body stays
 *    consistent with the "no picker" default path.
 *
 * When `allowedModels` is empty the picker is disabled — this happens
 * before the initial fetch completes or if the admin catalog and the
 * fallback provider list are both empty.
 *
 * Selection of a model not in `allowedModels` (E.1 fallback): the trigger
 * still shows the model id, but no check mark appears in the list. The
 * server still accepts the id (free-form input is honored end-to-end).
 */
export function ModelPersonaPicker({
  selectedModel,
  allowedModels,
  onSelectModel,
  selectedAgent,
  onSelectAgent,
}: {
  selectedModel: string | null;
  allowedModels: string[];
  onSelectModel: (model: string | null) => void;
  selectedAgent: string | null;
  onSelectAgent: (agent: string | null) => void;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<'models' | 'personas'>('models');
  const [personas, setPersonas] = useState<PersonaOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    listChatPersonasAction()
      .then((result) => {
        if (!cancelled) setPersonas(result.personas ?? []);
      })
      .catch((error) => {
        console.warn('[persona] load failed:', error);
        toast.error(t('chat.personaPicker.loadFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const [search, setSearch] = useState('');

  const sortedModels = useMemo(
    () => [...allowedModels].sort((a, b) => a.localeCompare(b)),
    [allowedModels],
  );

  const hasOverflow = sortedModels.length > MAX_VISIBLE_MODELS;

  // When the catalog overflows the visible window, a search box filters the
  // full list so every allowed model stays selectable. The current
  // selection is always pinned into the visible page even when it sorts
  // past the cutoff.
  const { visibleModels, hiddenCount } = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query) {
      const matches = sortedModels.filter((id) =>
        id.toLowerCase().includes(query),
      );
      return {
        visibleModels: matches.slice(0, MAX_VISIBLE_MODELS),
        hiddenCount: Math.max(0, matches.length - MAX_VISIBLE_MODELS),
      };
    }
    const page = sortedModels.slice(0, MAX_VISIBLE_MODELS);
    const items =
      selectedModel &&
      allowedModels.includes(selectedModel) &&
      !page.includes(selectedModel)
        ? [selectedModel, ...page.slice(0, MAX_VISIBLE_MODELS - 1)]
        : page;
    return {
      visibleModels: items,
      hiddenCount: sortedModels.length - items.length,
    };
  }, [sortedModels, search, selectedModel, allowedModels]);

  const display = selectedModel ? parseModelDisplay(selectedModel) : null;

  const isOpenEntry = !selectedModel || !allowedModels.includes(selectedModel);

  const isDisabled = allowedModels.length === 0;

  // Only 'main' exists — nothing to switch, so the persona row (and the
  // whole personas view) stays hidden to keep the popover a pure model list.
  const hasCustomPersonas = personas.some((persona) => persona.name !== 'main');
  const activePersona = selectedAgent
    ? personas.find((persona) => persona.name === selectedAgent)
    : null;

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        // Always reopen on the model list, with any search cleared.
        if (open) {
          setView('models');
          setSearch('');
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          className="flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isDisabled}
          type="button"
        >
          {display ? (
            <span className="truncate text-foreground text-lg tracking-tight">
              {display.model}
            </span>
          ) : (
            <span className="truncate text-lg text-muted-foreground tracking-tight">
              {t('chat.modelPicker.useDefault')}
            </span>
          )}
          {activePersona ? (
            <span className="truncate text-muted-foreground text-sm">
              · {activePersona.label}
            </span>
          ) : null}
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[260px] rounded-2xl p-2"
        collisionPadding={8}
        side="bottom"
      >
        {view === 'models' ? (
          <>
            {hasOverflow ? (
              <div className="px-1 pb-1">
                <Input
                  className="h-8 text-sm"
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    // Keep menu typeahead/roving focus from stealing input,
                    // but let Escape bubble so it still closes the menu.
                    if (event.key !== 'Escape') event.stopPropagation();
                  }}
                  placeholder={t('chat.modelPicker.search')}
                  value={search}
                />
              </div>
            ) : null}
            {/* Scrollable list: ~4 two-line items visible on mobile, nearly
                the whole catalog on desktop. Footers stay pinned outside. */}
            <div className="max-h-[260px] overflow-y-auto overscroll-contain md:max-h-[70vh]">
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
                    className="gap-2 rounded-lg px-2 py-2"
                    onSelect={() => onSelectModel(modelId)}
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center">
                      {selectedModel === modelId ? (
                        <Check className="size-4" />
                      ) : null}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-base leading-6">
                        {item.model}
                      </span>
                      {item.provider ? (
                        <span className="truncate text-muted-foreground text-xs leading-5">
                          {t('chat.modelPicker.provider', {
                            provider: item.provider,
                          })}
                        </span>
                      ) : null}
                    </span>
                  </DropdownMenuItem>
                );
              })}
              {visibleModels.length === 0 ? (
                <DropdownMenuLabel className="text-muted-foreground text-xs">
                  {t('chat.modelPicker.noResults')}
                </DropdownMenuLabel>
              ) : null}
            </div>

            {hiddenCount > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-muted-foreground text-xs">
                  {t('chat.modelPicker.moreAvailable', {
                    count: hiddenCount,
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

            {hasCustomPersonas ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="gap-2 rounded-lg px-2 py-2.5"
                  onSelect={(event) => {
                    // Drill in instead of closing the menu.
                    event.preventDefault();
                    setView('personas');
                  }}
                >
                  <span className="flex-1 truncate text-base">
                    {t('chat.personaPicker.title')}
                  </span>
                  {activePersona ? (
                    <span className="truncate text-muted-foreground text-xs">
                      {activePersona.label}
                    </span>
                  ) : null}
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </DropdownMenuItem>
              </>
            ) : null}
          </>
        ) : (
          <>
            <DropdownMenuItem
              className="gap-2 rounded-lg px-2 py-2"
              onSelect={(event) => {
                event.preventDefault();
                setView('models');
              }}
            >
              <ArrowLeft className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 text-base">
                {t('chat.personaPicker.back')}
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <div className="max-h-[260px] overflow-y-auto overscroll-contain md:max-h-[70vh]">
              {personas.map((persona) => (
                <DropdownMenuItem
                  key={persona.name}
                  className="gap-2 rounded-lg px-2 py-2"
                  onSelect={() => {
                    // 'main' maps to null (no override) so the request body
                    // stays consistent with the "no picker" default path.
                    onSelectAgent(
                      persona.name === 'main' ? null : persona.name,
                    );
                  }}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center">
                    {(selectedAgent ?? 'main') === persona.name ? (
                      <Check className="size-4" />
                    ) : null}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-base leading-6">
                        {persona.name === 'main'
                          ? t('chat.personaPicker.default')
                          : persona.label}
                      </span>
                      {persona.hasModelOverride ? (
                        <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wide">
                          {t('chat.personaPicker.modelBadge')}
                        </span>
                      ) : null}
                    </span>
                    {persona.description ? (
                      <span className="truncate text-muted-foreground text-xs leading-5">
                        {persona.description}
                      </span>
                    ) : null}
                  </span>
                </DropdownMenuItem>
              ))}
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
