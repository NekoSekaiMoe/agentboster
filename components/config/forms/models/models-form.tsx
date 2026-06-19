'use client';

import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/components/i18n-provider';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useConfigSection } from '@/hooks/use-config-section';
import type { AppConfig } from '@/types/config';
import {
  type AIConfig,
  type AIProvider,
  aiProviderEnum,
} from '@/types/config/ai';

/**
 * Human-readable labels for provider format values.
 * The underlying enum value (e.g. "openaicompatible") stays the same for
 * backward compatibility with stored configs; only the display text changes.
 */
const FORMAT_LABELS: Record<AIProvider, string> = {
  openaicompatible: 'OpenAI Legacy',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
};

function formatLabel(format: AIProvider): string {
  return FORMAT_LABELS[format] ?? format;
}

import {
  Field,
  KeyValueEditor,
  SectionIssues,
  compactRecord,
  createKeyValueEntries,
  parseOptionalNumber,
} from '../shared';
import {
  type ModelsDevCatalog,
  autoFillModelLimits,
  buildConfiguredProviderModelSuggestions,
  buildModelPredictions,
  createStableId,
  findModelLimit,
  listProviderNames,
  loadModelsDevCatalog,
  resolveCatalogProviderName,
} from './models-dev';
import { DeferredProviderIdInput } from './provider-id-input';
import { SuggestionInput } from './suggestion-input';

function createAvailableProviderKey(providers: Partial<AIConfig>['providers']) {
  const existingProviderKeys = new Set(Object.keys(providers ?? {}));
  let index = 1;

  while (existingProviderKeys.has(`provider-${index}`)) {
    index += 1;
  }

  return `provider-${index}`;
}

export function ModelsForm() {
  const { issues, value, updateValue } = useConfigSection('models');
  const { t } = useI18n();
  const reduceMotion = useReducedMotion();
  const models = (value ?? {}) as Partial<AIConfig>;
  const providers = Object.entries(models.providers ?? {});
  const [providerRowIds, setProviderRowIds] = useState<Record<string, string>>(
    {},
  );
  const [expandedProviderKeys, setExpandedProviderKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [modelsCatalog, setModelsCatalog] = useState<ModelsDevCatalog | null>(
    null,
  );
  // Catalog editor is maintained as an ordered local draft to allow
  // intermediate states (empty id, duplicate id while typing, rename in
  // flight) that the Record<string, ...> shape can't represent directly.
  // On every change we reconcile to a Record and call updateModels; rows
  // with empty/whitespace id are skipped during reconciliation.
  type CatalogDraftEntry = {
    rowId: string;
    id: string;
    overrides: {
      temperature?: number;
      context_limit?: number;
      max_output_tokens?: number;
    };
  };
  const [catalogDraft, setCatalogDraft] = useState<CatalogDraftEntry[]>([]);
  const catalogDraftRef = useRef<CatalogDraftEntry[]>([]);
  const [expandedCatalogRowIds, setExpandedCatalogRowIds] = useState<
    ReadonlySet<string>
  >(() => new Set());

  const updateModels = (
    updater: (current: Partial<AIConfig>) => Partial<AIConfig>,
  ) => {
    updateValue((currentModels) => {
      const current = (currentModels ?? {}) as Partial<AIConfig>;
      return updater(current) as AppConfig['models'];
    });
  };

  useEffect(() => {
    catalogDraftRef.current = catalogDraft;
  }, [catalogDraft]);

  // Sync the local draft from the canonical store value. Only re-syncs when
  // the store's catalog content actually differs from what the draft would
  // produce — avoids clobbering in-flight edits (empty id, focus, etc).
  useEffect(() => {
    const storeCatalog = models.model_catalog ?? {};
    const storeKeys = Object.keys(storeCatalog);
    const currentCatalogDraft = catalogDraftRef.current;
    const draftKeys = currentCatalogDraft
      .map((e) => e.id.trim())
      .filter((id) => id.length > 0);
    const sameLength = storeKeys.length === draftKeys.length;
    const sameContent =
      sameLength &&
      draftKeys.every(
        (k, i) =>
          k === storeKeys[i] &&
          JSON.stringify(currentCatalogDraft[i].overrides) ===
            JSON.stringify(storeCatalog[k]),
      );
    if (sameContent) return;

    const nextCatalogDraft = storeKeys.map((id) => ({
      rowId: createStableId('catalog-row'),
      id,
      overrides: { ...storeCatalog[id] },
    }));
    catalogDraftRef.current = nextCatalogDraft;
    setCatalogDraft(nextCatalogDraft);
  }, [models.model_catalog]);

  useEffect(() => {
    let disposed = false;

    loadModelsDevCatalog().then((catalog) => {
      if (!disposed) {
        setModelsCatalog(catalog);
      }
    });

    return () => {
      disposed = true;
    };
  }, []);

  const configuredProviderNames = useMemo(
    () => Object.keys(models.providers ?? {}),
    [models.providers],
  );

  // Determine the format of the first configured provider to adapt placeholders/help text.
  // When the primary provider is OpenAI Compatible, bare model names (no provider prefix) are
  // accepted because the base URL already implies the provider.
  const primaryProviderFormat = useMemo(() => {
    const firstKey = configuredProviderNames[0];
    if (!firstKey || !models.providers) return null;
    return models.providers[firstKey]?.format ?? null;
  }, [configuredProviderNames, models.providers]);

  const acceptsBareModelNames = primaryProviderFormat === 'openaicompatible';

  const defaultModelPlaceholder = acceptsBareModelNames
    ? 'deepseek-chat or provider/model-id'
    : 'anthropic/claude-sonnet-4-20250514';

  const embeddingModelPlaceholder = acceptsBareModelNames
    ? 'text-embedding-3-small or provider/model-id'
    : 'openai/text-embedding-3-small';

  const providerPredictions = useMemo(
    () => listProviderNames(modelsCatalog),
    [modelsCatalog],
  );
  const collapseTransition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.18, ease: [0.22, 1, 0.36, 1] };

  const modelPredictions = useMemo(
    () =>
      buildModelPredictions(
        models.model ?? '',
        configuredProviderNames,
        modelsCatalog,
      ),
    [configuredProviderNames, models.model, modelsCatalog],
  );

  const embeddingModelPredictions = useMemo(
    () =>
      buildModelPredictions(
        models.embedding_model ?? '',
        configuredProviderNames,
        modelsCatalog,
      ),
    [configuredProviderNames, models.embedding_model, modelsCatalog],
  );

  // Suggestion source for the model_catalog editor. Returns every model
  // the configured providers expose via models.dev — the admin picks a
  // subset from this list to expose to end users in the chat-box picker.
  const catalogPredictions = useMemo(
    () =>
      buildConfiguredProviderModelSuggestions(
        configuredProviderNames,
        modelsCatalog,
      ),
    [configuredProviderNames, modelsCatalog],
  );

  const predictedModelLimit = useMemo(() => {
    if (!modelsCatalog || !models.model) {
      return null;
    }

    return findModelLimit(modelsCatalog, models.model);
  }, [models.model, modelsCatalog]);

  useEffect(() => {
    setProviderRowIds((current) => {
      const next: Record<string, string> = {};

      for (const [providerKey] of providers) {
        next[providerKey] = current[providerKey] ?? createStableId('provider');
      }

      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(next);
      const unchanged =
        currentKeys.length === nextKeys.length &&
        nextKeys.every((key) => current[key] === next[key]);

      return unchanged ? current : next;
    });
  }, [providers]);

  function toggleProviderExpanded(providerKey: string) {
    setExpandedProviderKeys((current) => {
      const next = new Set(current);
      if (next.has(providerKey)) {
        next.delete(providerKey);
      } else {
        next.add(providerKey);
      }
      return next;
    });
  }

  function toggleCatalogRowExpanded(rowId: string) {
    setExpandedCatalogRowIds((current) => {
      const next = new Set(current);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
  }

  // Reconcile the local draft array to the canonical model_catalog Record.
  // Empty/whitespace ids are dropped. Duplicate ids keep the last write.
  function commitCatalogDraft(next: CatalogDraftEntry[]) {
    setCatalogDraft(next);
    const reconciled: Record<string, CatalogDraftEntry['overrides']> = {};
    for (const entry of next) {
      const id = entry.id.trim();
      if (!id) continue;
      reconciled[id] = entry.overrides;
    }
    updateModels((current) => ({
      ...current,
      model_catalog:
        Object.keys(reconciled).length > 0 ? reconciled : undefined,
    }));
  }

  return (
    <div className="space-y-6">
      <SectionIssues issues={issues} />

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">
            {t('config.forms.models.defaultSettingsTitle')}
          </CardTitle>
          <CardDescription>
            {t('config.forms.models.defaultSettingsDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label={t('config.forms.models.globalDefaultModel')}>
            <SuggestionInput
              placeholder={defaultModelPlaceholder}
              suggestions={modelPredictions}
              value={models.model ?? ''}
              onChange={(nextModel) => {
                const autoFilled = autoFillModelLimits(
                  models,
                  modelsCatalog,
                  nextModel,
                );

                updateValue({
                  ...models,
                  ...autoFilled,
                  model: nextModel,
                } as AppConfig['models']);
              }}
            />
            <p className="mt-1 text-muted-foreground text-xs">
              {t('config.forms.models.globalDefaultModelHelp')}
            </p>
            {acceptsBareModelNames && (
              <p className="mt-1 text-muted-foreground text-xs">
                {t('config.forms.models.bareModelHelp')}
              </p>
            )}
          </Field>
          <Field label={t('config.forms.models.embeddingModel')}>
            <SuggestionInput
              placeholder={embeddingModelPlaceholder}
              suggestions={embeddingModelPredictions}
              value={models.embedding_model ?? ''}
              onChange={(nextEmbeddingModel) =>
                updateValue({
                  ...models,
                  embedding_model: nextEmbeddingModel || undefined,
                } as AppConfig['models'])
              }
            />
          </Field>
          <div className="text-muted-foreground text-xs md:col-span-2">
            {t('config.forms.models.embeddingWarning')}
          </div>
          <Field label={t('config.forms.agents.temperature')}>
            <Input
              max="2"
              min="0"
              step="0.1"
              type="number"
              value={models.temperature ?? 0.7}
              onChange={(event) =>
                updateValue({
                  ...models,
                  temperature: Number(event.target.value),
                } as AppConfig['models'])
              }
            />
          </Field>
          <div className="space-y-2">
            <Field label={t('config.forms.models.defaultContextLimit')}>
              <Input
                min="1"
                placeholder="128000"
                type="number"
                value={models.context_limit ?? ''}
                onChange={(event) =>
                  updateValue({
                    ...models,
                    context_limit: parseOptionalNumber(event.target.value),
                  } as AppConfig['models'])
                }
              />
            </Field>
            <p className="text-muted-foreground text-xs">
              {t('config.forms.models.defaultContextHelp')}
            </p>
          </div>
          <div className="space-y-2">
            <Field label={t('config.forms.models.maxOutputTokens')}>
              <Input
                min="1"
                placeholder="4096"
                type="number"
                value={models.max_output_tokens ?? ''}
                onChange={(event) =>
                  updateValue({
                    ...models,
                    max_output_tokens: parseOptionalNumber(event.target.value),
                  } as AppConfig['models'])
                }
              />
            </Field>
            {typeof predictedModelLimit?.output === 'number' ? (
              <p className="text-muted-foreground text-xs">
                {t('config.forms.models.keepBelowLimit', {
                  limit: predictedModelLimit.output,
                })}
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">
            {t('config.forms.models.catalogTitle')}
          </CardTitle>
          <CardDescription>
            {t('config.forms.models.catalogDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {catalogDraft.map((entry, index) => {
            const isExpanded = expandedCatalogRowIds.has(entry.rowId);

            const updateEntryId = (nextId: string) => {
              const next = catalogDraft.map((e, i) =>
                i === index ? { ...e, id: nextId } : e,
              );
              commitCatalogDraft(next);
            };

            const updateEntryOverrides = (
              overrides: CatalogDraftEntry['overrides'],
            ) => {
              const next = catalogDraft.map((e, i) =>
                i === index ? { ...e, overrides } : e,
              );
              commitCatalogDraft(next);
            };

            const removeEntry = () => {
              const next = catalogDraft.filter((_, i) => i !== index);
              commitCatalogDraft(next);
            };

            return (
              <div
                key={entry.rowId}
                className="overflow-hidden rounded-2xl border"
              >
                <div className="grid gap-2 md:grid-cols-[1fr_auto_auto]">
                  <SuggestionInput
                    placeholder={t(
                      'config.forms.models.catalogModelPlaceholder',
                    )}
                    showChevron={false}
                    suggestions={catalogPredictions}
                    value={entry.id}
                    onChange={updateEntryId}
                  />
                  <Button
                    aria-expanded={isExpanded}
                    aria-label={t('config.forms.models.catalogToggleParams')}
                    className="md:self-start"
                    onClick={() => toggleCatalogRowExpanded(entry.rowId)}
                    size="icon"
                    type="button"
                    variant="outline"
                  >
                    <ChevronDown
                      className={`size-4 transition-transform ${
                        isExpanded ? 'rotate-180' : ''
                      }`}
                    />
                  </Button>
                  <Button
                    className="md:self-start"
                    onClick={removeEntry}
                    size="icon"
                    type="button"
                    variant="outline"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>

                <AnimatePresence initial={false}>
                  {isExpanded ? (
                    <motion.div
                      animate={{ height: 'auto', opacity: 1 }}
                      className="border-t"
                      exit={{ height: 0, opacity: 0 }}
                      initial={{ height: 0, opacity: 0 }}
                      transition={collapseTransition}
                    >
                      <div className="grid gap-3 p-3 md:grid-cols-3">
                        <Field label={t('config.forms.agents.temperature')}>
                          <Input
                            max="2"
                            min="0"
                            placeholder={t(
                              'config.forms.models.catalogUseGlobal',
                            )}
                            step="0.1"
                            type="number"
                            value={
                              entry.overrides.temperature != null
                                ? String(entry.overrides.temperature)
                                : ''
                            }
                            onChange={(event) =>
                              updateEntryOverrides({
                                ...entry.overrides,
                                temperature: parseOptionalNumber(
                                  event.target.value,
                                ),
                              })
                            }
                          />
                        </Field>
                        <Field
                          label={t('config.forms.models.defaultContextLimit')}
                        >
                          <Input
                            min="1"
                            placeholder={t(
                              'config.forms.models.catalogUseGlobal',
                            )}
                            type="number"
                            value={
                              entry.overrides.context_limit != null
                                ? String(entry.overrides.context_limit)
                                : ''
                            }
                            onChange={(event) =>
                              updateEntryOverrides({
                                ...entry.overrides,
                                context_limit: parseOptionalNumber(
                                  event.target.value,
                                ),
                              })
                            }
                          />
                        </Field>
                        <Field label={t('config.forms.models.maxOutputTokens')}>
                          <Input
                            min="1"
                            placeholder={t(
                              'config.forms.models.catalogUseGlobal',
                            )}
                            type="number"
                            value={
                              entry.overrides.max_output_tokens != null
                                ? String(entry.overrides.max_output_tokens)
                                : ''
                            }
                            onChange={(event) =>
                              updateEntryOverrides({
                                ...entry.overrides,
                                max_output_tokens: parseOptionalNumber(
                                  event.target.value,
                                ),
                              })
                            }
                          />
                        </Field>
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
            );
          })}

          <Button
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => {
              const newRow: CatalogDraftEntry = {
                rowId: createStableId('catalog-row'),
                id: '',
                overrides: {},
              };
              const next = [...catalogDraft, newRow];
              setCatalogDraft(next);
              setExpandedCatalogRowIds((current) =>
                new Set(current).add(newRow.rowId),
              );
            }}
          >
            <Plus className="size-4" />
            {t('config.forms.models.catalogAddModel')}
          </Button>
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">
            {t('config.forms.models.providers')}
          </CardTitle>
          <CardDescription>
            {t('config.forms.models.providerDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {providers.map(([providerKey, providerValue]) => {
            const isExpanded = expandedProviderKeys.has(providerKey);

            return (
              <div
                key={providerRowIds[providerKey] ?? providerKey}
                className="rounded-2xl border"
              >
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                  aria-expanded={isExpanded}
                  onClick={() => toggleProviderExpanded(providerKey)}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-sm">
                      {providerKey}
                    </span>
                    <span className="block truncate text-muted-foreground text-xs">
                      {formatLabel(providerValue.format)}
                      {providerValue.base_url
                        ? ` · ${providerValue.base_url}`
                        : ''}
                    </span>
                  </span>
                  <ChevronDown
                    className={`size-4 shrink-0 text-muted-foreground transition-transform ${
                      isExpanded ? 'rotate-180' : ''
                    }`}
                  />
                </button>

                <AnimatePresence initial={false}>
                  {isExpanded ? (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={collapseTransition}
                      className="overflow-hidden border-t"
                    >
                      <div className="space-y-4 p-4">
                        <div className="grid gap-4 md:grid-cols-2">
                          <Field label={t('config.forms.models.providerId')}>
                            <DeferredProviderIdInput
                              providerKey={providerKey}
                              suggestions={providerPredictions}
                              onCommit={(nextProviderName) => {
                                if (nextProviderName === providerKey) {
                                  return;
                                }

                                setProviderRowIds((current) => {
                                  const rowId =
                                    current[providerKey] ??
                                    createStableId('provider');
                                  const next = { ...current };
                                  delete next[providerKey];
                                  next[nextProviderName] = rowId;
                                  return next;
                                });

                                const catalogProvider = modelsCatalog
                                  ? resolveCatalogProviderName(
                                      nextProviderName,
                                      modelsCatalog,
                                    )
                                  : null;
                                const predictedBaseUrl = catalogProvider
                                  ? modelsCatalog?.[catalogProvider]?.api
                                  : undefined;
                                updateModels((current) => {
                                  const nextProviders = {
                                    ...(current.providers ?? {}),
                                  };
                                  const currentProvider =
                                    nextProviders[providerKey] ?? providerValue;
                                  delete nextProviders[providerKey];
                                  nextProviders[nextProviderName] = {
                                    ...currentProvider,
                                    base_url:
                                      predictedBaseUrl ??
                                      currentProvider.base_url,
                                  };
                                  return {
                                    ...current,
                                    providers: nextProviders,
                                  };
                                });
                              }}
                            />
                          </Field>
                          <Field label={t('config.forms.models.format')}>
                            <Select
                              value={providerValue.format}
                              onValueChange={(nextValue) =>
                                updateModels((current) => ({
                                  ...current,
                                  providers: {
                                    ...(current.providers ?? {}),
                                    [providerKey]: {
                                      ...(current.providers?.[providerKey] ??
                                        providerValue),
                                      format: nextValue as AIProvider,
                                    },
                                  },
                                }))
                              }
                            >
                              <SelectTrigger>
                                <SelectValue
                                  placeholder={t(
                                    'config.forms.models.selectProviderFormat',
                                  )}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                {aiProviderEnum.options.map((option) => (
                                  <SelectItem key={option} value={option}>
                                    {formatLabel(option as AIProvider)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </Field>
                          <Field label={t('config.agentd.apiKey')}>
                            <Input
                              placeholder="optional"
                              value={providerValue.api_key ?? ''}
                              onChange={(event) =>
                                updateModels((current) => ({
                                  ...current,
                                  providers: {
                                    ...(current.providers ?? {}),
                                    [providerKey]: {
                                      ...(current.providers?.[providerKey] ??
                                        providerValue),
                                      api_key: event.target.value || undefined,
                                    },
                                  },
                                }))
                              }
                            />
                          </Field>
                          <Field label={t('config.common.baseUrl')}>
                            <Input
                              placeholder="https://api.example.com/v1"
                              value={providerValue.base_url ?? ''}
                              onChange={(event) =>
                                updateModels((current) => ({
                                  ...current,
                                  providers: {
                                    ...(current.providers ?? {}),
                                    [providerKey]: {
                                      ...(current.providers?.[providerKey] ??
                                        providerValue),
                                      base_url: event.target.value || undefined,
                                    },
                                  },
                                }))
                              }
                            />
                          </Field>
                        </div>

                        <div className="space-y-2">
                          <Field label={t('config.common.headers')}>
                            <KeyValueEditor
                              addLabel={t('config.common.addHeader')}
                              entries={createKeyValueEntries(
                                providerValue.headers,
                              )}
                              keyLabel={t('config.common.headerKey')}
                              onChange={(entries) =>
                                updateModels((current) => ({
                                  ...current,
                                  providers: {
                                    ...(current.providers ?? {}),
                                    [providerKey]: {
                                      ...(current.providers?.[providerKey] ??
                                        providerValue),
                                      headers: compactRecord(entries),
                                    },
                                  },
                                }))
                              }
                              valueLabel={t('config.common.headerValue')}
                            />
                          </Field>
                        </div>

                        <div className="flex justify-end">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                              updateModels((current) => {
                                const nextProviders = {
                                  ...(current.providers ?? {}),
                                };
                                delete nextProviders[providerKey];
                                return {
                                  ...current,
                                  providers: nextProviders,
                                };
                              });
                            }}
                          >
                            <Trash2 className="size-4" />
                            {t('config.forms.models.removeProvider')}
                          </Button>
                        </div>
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
            );
          })}

          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              let nextProviderKey = '';

              updateModels((current) => {
                nextProviderKey = createAvailableProviderKey(current.providers);

                return {
                  ...current,
                  providers: {
                    ...(current.providers ?? {}),
                    [nextProviderKey]: {
                      format: 'openai',
                    },
                  },
                };
              });

              if (nextProviderKey) {
                setProviderRowIds((current) => ({
                  ...current,
                  [nextProviderKey]: createStableId('provider'),
                }));
                setExpandedProviderKeys((current) => {
                  const next = new Set(current);
                  next.add(nextProviderKey);
                  return next;
                });
              }
            }}
          >
            <Plus className="size-4" />
            {t('config.forms.models.addProvider')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
