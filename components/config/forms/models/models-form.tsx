'use client';

import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

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

  const updateModels = (
    updater: (current: Partial<AIConfig>) => Partial<AIConfig>,
  ) => {
    updateValue((currentModels) => {
      const current = (currentModels ?? {}) as Partial<AIConfig>;
      return updater(current) as AppConfig['models'];
    });
  };

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
          <Field label={t('config.forms.models.defaultModel')}>
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
                      {providerValue.format}
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

                {isExpanded ? (
                  <div className="space-y-4 border-t p-4">
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
                                  predictedBaseUrl ?? currentProvider.base_url,
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
                                {option}
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
                          entries={createKeyValueEntries(providerValue.headers)}
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
                ) : null}
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
