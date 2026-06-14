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

              {/* P1.1: daemon-side knobs. Optional; omitted values fall back
                  to daemon defaults. Kept on a separate visual block so the
                  basic model/prompt fields stay uncluttered. */}
              <details className="mt-4 rounded-lg border bg-muted/30 p-3 text-sm">
                <summary className="cursor-pointer select-none font-medium">
                  Daemon settings (sandbox, resources, MCP, egress)
                </summary>

                <div className="mt-3 grid gap-4 md:grid-cols-2">
                  <Field label="Sandbox type">
                    <select
                      className="w-full rounded border bg-background px-2 py-1"
                      value={agentValue.sandbox_type ?? 'auto'}
                      onChange={(event) =>
                        updateValue({
                          ...agents,
                          [agentKey]: {
                            ...agentValue,
                            sandbox_type:
                              event.target.value === 'auto'
                                ? undefined
                                : (event.target.value as
                                    | 'docker'
                                    | 'docker-strict'
                                    | 'lxc'),
                          },
                        })
                      }
                    >
                      <option value="auto">auto (daemon picks)</option>
                      <option value="docker">docker (light)</option>
                      <option value="docker-strict">docker-strict</option>
                      <option value="lxc">lxc (persistent)</option>
                    </select>
                  </Field>

                  <Field label="CPU cores">
                    <Input
                      type="number"
                      min="0.1"
                      step="0.25"
                      placeholder="e.g. 0.5"
                      value={agentValue.sandbox_cpu ?? ''}
                      onChange={(event) =>
                        updateValue({
                          ...agents,
                          [agentKey]: {
                            ...agentValue,
                            sandbox_cpu:
                              parseOptionalNumber(event.target.value),
                          },
                        })
                      }
                    />
                  </Field>

                  <Field label="Memory">
                    <Input
                      type="text"
                      placeholder='e.g. "256m", "1g"'
                      value={agentValue.sandbox_mem ?? ''}
                      onChange={(event) =>
                        updateValue({
                          ...agents,
                          [agentKey]: {
                            ...agentValue,
                            sandbox_mem: event.target.value || undefined,
                          },
                        })
                      }
                    />
                  </Field>

                  <Field label="PIDs limit">
                    <Input
                      type="number"
                      min="1"
                      placeholder="e.g. 128"
                      value={agentValue.sandbox_pids ?? ''}
                      onChange={(event) =>
                        updateValue({
                          ...agents,
                          [agentKey]: {
                            ...agentValue,
                            sandbox_pids:
                              parseOptionalNumber(event.target.value),
                          },
                        })
                      }
                    />
                  </Field>

                  <Field label="Max parallel subagents">
                    <Input
                      type="number"
                      min="1"
                      max="32"
                      placeholder="default 3"
                      value={agentValue.max_parallel_subagents ?? ''}
                      onChange={(event) =>
                        updateValue({
                          ...agents,
                          [agentKey]: {
                            ...agentValue,
                            max_parallel_subagents:
                              parseOptionalNumber(event.target.value),
                          },
                        })
                      }
                    />
                  </Field>

                  <Field label="Allowed daemon nodes (comma-separated)">
                    <Input
                      type="text"
                      placeholder="empty = any node"
                      value={(agentValue.allowed_nodes ?? []).join(',')}
                      onChange={(event) =>
                        updateValue({
                          ...agents,
                          [agentKey]: {
                            ...agentValue,
                            allowed_nodes: event.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          },
                        })
                      }
                    />
                  </Field>

                  <Field label="MCP servers (comma-separated)">
                    <Input
                      type="text"
                      placeholder="e.g. github, context7"
                      value={(agentValue.mcp_servers ?? []).join(',')}
                      onChange={(event) =>
                        updateValue({
                          ...agents,
                          [agentKey]: {
                            ...agentValue,
                            mcp_servers: event.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          },
                        })
                      }
                    />
                  </Field>

                  <Field label="Egress allowlist (glob, comma-separated)">
                    <Input
                      type="text"
                      placeholder='e.g. "*.npmjs.org, github.com"'
                      value={(agentValue.egress_allowlist ?? []).join(',')}
                      onChange={(event) =>
                        updateValue({
                          ...agents,
                          [agentKey]: {
                            ...agentValue,
                            egress_allowlist: event.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          },
                        })
                      }
                    />
                  </Field>

                  {/* P2.2: quick presets for common package registries */}
                  <div className="md:col-span-2 flex flex-wrap gap-2 text-xs">
                    <span className="self-center text-muted-foreground">
                      Presets:
                    </span>
                    {(
                      [
                        ['npm', ['*.npmjs.org', 'registry.npmjs.org']],
                        ['pypi', ['*.pypi.org', 'files.pythonhosted.org']],
                        ['github', ['github.com', '*.github.com', '*.githubusercontent.com']],
                        ['docker hub', ['*.docker.com', '*.docker.io']],
                      ] as const
                    ).map(([label, hosts]) => (
                      <button
                        type="button"
                        key={label}
                        className="rounded border bg-background px-2 py-1 hover:bg-accent"
                        onClick={() =>
                          updateValue({
                            ...agents,
                            [agentKey]: {
                              ...agentValue,
                              egress_allowlist: Array.from(
                                new Set([
                                  ...(agentValue.egress_allowlist ?? []),
                                  ...hosts,
                                ]),
                              ),
                            },
                          })
                        }
                      >
                        + {label}
                      </button>
                    ))}
                    {(agentValue.egress_allowlist ?? []).length > 0 && (
                      <button
                        type="button"
                        className="rounded border bg-background px-2 py-1 text-destructive hover:bg-accent"
                        onClick={() =>
                          updateValue({
                            ...agents,
                            [agentKey]: {
                              ...agentValue,
                              egress_allowlist: [],
                            },
                          })
                        }
                      >
                        clear
                      </button>
                    )}
                  </div>

                  <Field label="Disk quota">
                    <Input
                      type="text"
                      placeholder='e.g. "1g"'
                      value={agentValue.sandbox_disk ?? ''}
                      onChange={(event) =>
                        updateValue({
                          ...agents,
                          [agentKey]: {
                            ...agentValue,
                            sandbox_disk: event.target.value || undefined,
                          },
                        })
                      }
                    />
                  </Field>

                  <Field label="Block IO weight (10-1000)">
                    <Input
                      type="number"
                      min="10"
                      max="1000"
                      placeholder="default 500"
                      value={agentValue.sandbox_blkio_weight ?? ''}
                      onChange={(event) =>
                        updateValue({
                          ...agents,
                          [agentKey]: {
                            ...agentValue,
                            sandbox_blkio_weight:
                              parseOptionalNumber(event.target.value),
                          },
                        })
                      }
                    />
                  </Field>
                </div>

                <div className="mt-4 flex flex-wrap gap-6">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={agentValue.mcp_enabled ?? false}
                      onChange={(event) =>
                        updateValue({
                          ...agents,
                          [agentKey]: {
                            ...agentValue,
                            mcp_enabled: event.target.checked,
                          },
                        })
                      }
                    />
                    Enable MCP tool bridge
                  </label>

                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={agentValue.custom_l0_rules ?? false}
                      onChange={(event) =>
                        updateValue({
                          ...agents,
                          [agentKey]: {
                            ...agentValue,
                            custom_l0_rules: event.target.checked,
                          },
                        })
                      }
                    />
                    Use agent-specific L0 rules
                  </label>
                </div>
              </details>

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
