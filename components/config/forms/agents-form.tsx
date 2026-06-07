'use client';

import { Plus, Trash2 } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { useConfigSection } from '@/hooks/use-config-section';
import type { AgentConfig } from '@/types/config/agents';
import type { AIConfig } from '@/types/config/ai';

import {
  type ModelsDevCatalog,
  buildModelPredictions,
  createStableId,
  loadModelsDevCatalog,
} from './models/models-dev';
import { SuggestionInput } from './models/suggestion-input';
import {
  EditableObjectKeyInput,
  Field,
  SectionIssues,
  parseOptionalNumber,
} from './shared';

export function AgentsForm() {
  const { issues, value, updateValue } = useConfigSection('agents');
  const { value: modelsValue } = useConfigSection('models');
  const { t } = useI18n();
  const agents = (value ?? {}) as AgentConfig;
  const models = (modelsValue ?? {}) as Partial<AIConfig>;
  const entries = Object.entries(agents);
  const [agentRowIds, setAgentRowIds] = useState<Record<string, string>>({});
  const [modelsCatalog, setModelsCatalog] = useState<ModelsDevCatalog | null>(
    null,
  );

  useEffect(() => {
    setAgentRowIds((current) => {
      const next: Record<string, string> = {};

      for (const [agentKey] of entries) {
        next[agentKey] = current[agentKey] ?? createStableId('agent');
      }

      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(next);
      const unchanged =
        currentKeys.length === nextKeys.length &&
        nextKeys.every((key) => current[key] === next[key]);

      return unchanged ? current : next;
    });
  }, [entries]);

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

  return (
    <div className="space-y-6">
      <SectionIssues issues={issues} />

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">
            {t('config.forms.agents.title')}
          </CardTitle>
          <CardDescription>
            {t('config.forms.agents.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {entries.map(([agentKey, agentValue]) => (
            <div
              key={agentRowIds[agentKey] ?? agentKey}
              className="rounded-2xl border p-4"
            >
              <div className="grid gap-4 md:grid-cols-2">
                <Field label={t('config.forms.agents.name')}>
                  <EditableObjectKeyInput
                    currentKey={agentKey}
                    onCommit={(nextKey) => {
                      if (nextKey === agentKey) {
                        return;
                      }

                      const rowId =
                        agentRowIds[agentKey] ?? createStableId('agent');

                      setAgentRowIds((current) => {
                        const next = { ...current };
                        delete next[agentKey];
                        next[nextKey] = rowId;
                        return next;
                      });

                      const nextAgents = { ...agents };
                      delete nextAgents[agentKey];
                      nextAgents[nextKey] = agentValue;
                      updateValue(nextAgents);
                    }}
                  />
                </Field>
                <Field label={t('config.forms.agents.model')}>
                  <SuggestionInput
                    placeholder="openai/gpt-4o-mini"
                    suggestions={buildModelPredictions(
                      agentValue.model ?? '',
                      configuredProviderNames,
                      modelsCatalog,
                    )}
                    value={agentValue.model ?? ''}
                    onChange={(nextModel) =>
                      updateValue({
                        ...agents,
                        [agentKey]: {
                          ...agentValue,
                          model: nextModel || undefined,
                        },
                      })
                    }
                  />
                </Field>
                <Field label={t('config.forms.agents.temperature')}>
                  <Input
                    max="2"
                    min="0"
                    step="0.1"
                    type="number"
                    value={agentValue.temperature ?? ''}
                    onChange={(event) =>
                      updateValue({
                        ...agents,
                        [agentKey]: {
                          ...agentValue,
                          temperature: parseOptionalNumber(event.target.value),
                        },
                      })
                    }
                  />
                </Field>
              </div>

              <div className="mt-4">
                <Field label={t('config.forms.agents.systemPrompt')}>
                  <Textarea
                    className="min-h-32"
                    placeholder={t(
                      'config.forms.agents.systemPromptPlaceholder',
                    )}
                    value={agentValue.system_prompt ?? ''}
                    onChange={(event) =>
                      updateValue({
                        ...agents,
                        [agentKey]: {
                          ...agentValue,
                          system_prompt: event.target.value || undefined,
                        },
                      })
                    }
                  />
                </Field>
              </div>

              <div className="mt-4 flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    const nextAgents = { ...agents };
                    delete nextAgents[agentKey];
                    updateValue(nextAgents);
                  }}
                >
                  <Trash2 className="size-4" />
                  {t('config.forms.agents.remove')}
                </Button>
              </div>
            </div>
          ))}

          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              updateValue({
                ...agents,
                [`agent-${entries.length + 1}`]: {},
              })
            }
          >
            <Plus className="size-4" />
            {t('config.forms.agents.add')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
