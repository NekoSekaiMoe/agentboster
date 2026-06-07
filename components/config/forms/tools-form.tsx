'use client';

import { useEffect, useMemo, useState } from 'react';

import { loadToolCatalogAction } from '@/app/(config)/actions';

import { useI18n } from '@/components/i18n-provider';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useConfigSection } from '@/hooks/use-config-section';
import type {
  ToolCatalogItem,
  ToolCatalogResponse,
  ToolConfig,
  ToolEntryConfig,
} from '@/types/config/tools';

import { Field, SectionIssues, ToggleField } from './shared';

const DEFAULT_TOOL_VALUE: ToolEntryConfig = {
  enabled: true,
  config: {},
  minUserType: 'user',
};

function hasText(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function getToolValue(tools: ToolConfig, toolId: string): ToolEntryConfig {
  const current = tools[toolId];

  if (!current) {
    return DEFAULT_TOOL_VALUE;
  }

  return {
    enabled: current.enabled ?? true,
    name: current.name,
    config: current.config ?? {},
    minUserType: current.minUserType ?? 'user',
  };
}

function pickAllowedConfig(
  config: Record<string, string> | undefined,
  allowedKeys: readonly string[],
) {
  if (!config) {
    return {};
  }

  const allowed = new Set(allowedKeys);

  return Object.fromEntries(
    Object.entries(config).filter(([key]) => allowed.has(key)),
  );
}

export function ToolsForm() {
  const { issues, value, updateValue } = useConfigSection('tools');
  const { t } = useI18n();
  const tools = (value ?? {}) as ToolConfig;
  const [catalog, setCatalog] = useState<ToolCatalogResponse | null>(null);
  const [catalogLoadError, setCatalogLoadError] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;

    const loadCatalog = async () => {
      try {
        const response = await loadToolCatalogAction();

        if (!isActive) {
          return;
        }

        setCatalog(response);
        setCatalogLoadError(null);
      } catch {
        if (!isActive) {
          return;
        }

        setCatalogLoadError(t('config.forms.tools.catalogLoadError'));
      }
    };

    loadCatalog();

    return () => {
      isActive = false;
    };
  }, []);

  const catalogTools = catalog?.tools ?? [];
  const catalogToolMap = useMemo(
    () =>
      new Map<string, ToolCatalogItem>(
        catalogTools.map((tool) => [tool.id, tool]),
      ),
    [catalogTools],
  );
  const builtInToolIds = catalogTools.map((tool) => tool.id);
  const visibleToolIds =
    builtInToolIds.length > 0 ? builtInToolIds : Object.keys(tools);

  const updateTool = (toolId: string, nextValue: ToolEntryConfig) => {
    if (builtInToolIds.length === 0) {
      updateValue({
        ...tools,
        [toolId]: nextValue,
      });
      return;
    }

    const nextTools = builtInToolIds.reduce<ToolConfig>((allTools, id) => {
      const existing = tools[id];
      if (existing) {
        allTools[id] = existing;
      }

      return allTools;
    }, {});

    nextTools[toolId] = nextValue;
    updateValue(nextTools);
  };

  return (
    <div className="space-y-6">
      <SectionIssues
        issues={
          catalogLoadError
            ? [...issues, { path: 'tools', message: catalogLoadError }]
            : issues
        }
      />

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">
            {t('config.forms.tools.builtinTools')}
          </CardTitle>
          <CardDescription>
            {t('config.forms.tools.builtinDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {visibleToolIds.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t('config.forms.tools.noTools')}
            </p>
          ) : (
            visibleToolIds.map((toolId) => {
              const catalogItem = catalogToolMap.get(toolId);
              const requiredConfig = catalogItem?.requiredConfig ?? [];
              const optionalConfig = catalogItem?.optionalConfig ?? [];
              const allowedConfigKeys = [...requiredConfig, ...optionalConfig];
              const toolValue = getToolValue(tools, toolId);
              const config = pickAllowedConfig(
                toolValue.config,
                allowedConfigKeys,
              );
              const hasConfigFields = allowedConfigKeys.length > 0;
              const missingRequiredInDraft = requiredConfig.filter(
                (key) => !hasText(config[key]),
              );

              return (
                <div key={toolId} className="rounded-2xl border p-4">
                  <div className="space-y-2">
                    <p className="font-medium text-sm">
                      {t('config.common.id')}
                    </p>
                    <p className="rounded-xl border bg-muted/30 px-3 py-2 text-sm">
                      {toolId}
                    </p>
                  </div>

                  <div className="mt-3 space-y-2">
                    <p className="font-medium text-sm">
                      {t('config.common.description')}
                    </p>
                    <p className="text-muted-foreground text-sm">
                      {catalogItem?.description ??
                        t('config.common.noDescription')}
                    </p>
                  </div>

                  <div className="mt-4">
                    <ToggleField
                      checked={toolValue.enabled ?? true}
                      label={t('config.common.enabled')}
                      onCheckedChange={(checked) =>
                        updateTool(toolId, {
                          ...toolValue,
                          enabled: checked,
                        })
                      }
                    />
                  </div>

                  {missingRequiredInDraft.length > 0 ? (
                    <p className="mt-3 text-amber-700 text-sm">
                      {t('config.forms.tools.missingRequired', {
                        keys: missingRequiredInDraft.join(', '),
                      })}
                    </p>
                  ) : null}

                  <div className="mt-4 space-y-3">
                    <p className="font-medium text-sm">
                      {t('config.common.configure')}
                    </p>

                    {requiredConfig.map((configKey) => (
                      <Field
                        key={`${toolId}-required-${configKey}`}
                        label={`${configKey} (${t('config.common.required')})`}
                      >
                        <Input
                          placeholder={t('config.common.requiredValue')}
                          value={config[configKey] ?? ''}
                          onChange={(event) => {
                            const nextConfig = { ...config };
                            const nextValue = event.target.value;

                            if (hasText(nextValue)) {
                              nextConfig[configKey] = nextValue;
                            } else {
                              delete nextConfig[configKey];
                            }

                            updateTool(toolId, {
                              ...toolValue,
                              config: nextConfig,
                            });
                          }}
                        />
                      </Field>
                    ))}

                    {optionalConfig.map((configKey) => (
                      <Field
                        key={`${toolId}-optional-${configKey}`}
                        label={`${configKey} (${t('config.common.optional')})`}
                      >
                        <Input
                          placeholder={t('config.common.optionalValue')}
                          value={config[configKey] ?? ''}
                          onChange={(event) => {
                            const nextConfig = { ...config };
                            const nextValue = event.target.value;

                            if (hasText(nextValue)) {
                              nextConfig[configKey] = nextValue;
                            } else {
                              delete nextConfig[configKey];
                            }

                            updateTool(toolId, {
                              ...toolValue,
                              config: nextConfig,
                            });
                          }}
                        />
                      </Field>
                    ))}

                    {!hasConfigFields ? (
                      <p className="text-muted-foreground text-sm">
                        {t('config.forms.tools.noConfigurableFields')}
                      </p>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
