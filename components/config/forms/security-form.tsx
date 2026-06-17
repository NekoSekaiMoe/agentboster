'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/components/i18n-provider';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useConfigSection } from '@/hooks/use-config-section';
import type { AIConfig } from '@/types/config/ai';
import type { SecurityConfig } from '@/types/config/security';

import {
  type ModelsDevCatalog,
  buildModelPredictions,
  loadModelsDevCatalog,
} from './models/models-dev';
import { SuggestionInput } from './models/suggestion-input';
import { Field, SectionIssues } from './shared';

type L0RuleType = 'command' | 'path' | 'network';
type L0RuleAction = 'block' | 'warn';
type L0RuleScope = 'workspace' | 'global';

interface L0Rule {
  id: string;
  agentId: string;
  pattern: string;
  type: L0RuleType;
  action: L0RuleAction;
  scope: L0RuleScope;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

type L0RuleDraft = Pick<
  L0Rule,
  'action' | 'agentId' | 'enabled' | 'pattern' | 'scope' | 'type'
>;

const emptyRuleDraft: L0RuleDraft = {
  action: 'block',
  agentId: 'global',
  enabled: true,
  pattern: '',
  scope: 'global',
  type: 'command',
};

async function fetchL0Rules(): Promise<L0Rule[]> {
  const response = await fetch('/api/config/l0-rules');
  if (!response.ok) {
    throw new Error('Failed to fetch L0 rules');
  }

  const body = (await response.json()) as { rules?: L0Rule[] };
  return body.rules ?? [];
}

async function createL0Rule(draft: L0RuleDraft): Promise<L0Rule> {
  const response = await fetch('/api/config/l0-rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });

  if (!response.ok) {
    throw new Error('Failed to create L0 rule');
  }

  const body = (await response.json()) as { rule: L0Rule };
  return body.rule;
}

async function updateL0Rule(
  id: string,
  patch: Partial<L0RuleDraft>,
): Promise<L0Rule> {
  const response = await fetch('/api/config/l0-rules', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...patch }),
  });

  if (!response.ok) {
    throw new Error('Failed to update L0 rule');
  }

  const body = (await response.json()) as { rule: L0Rule };
  return body.rule;
}

async function deleteL0Rule(id: string): Promise<void> {
  const response = await fetch('/api/config/l0-rules', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });

  if (!response.ok) {
    throw new Error('Failed to delete L0 rule');
  }
}

export function SecurityForm() {
  const { issues, value, updateValue } = useConfigSection('security');
  const { value: modelsValue } = useConfigSection('models');
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const security = (value ?? {}) as Partial<SecurityConfig>;
  const models = (modelsValue ?? {}) as Partial<AIConfig>;
  const [modelsCatalog, setModelsCatalog] = useState<ModelsDevCatalog | null>(
    null,
  );
  const [newRule, setNewRule] = useState<L0RuleDraft>(emptyRuleDraft);

  const { data: l0Rules, isLoading: l0RulesLoading } = useQuery({
    queryKey: ['config-l0-rules'],
    queryFn: fetchL0Rules,
  });

  const createRuleMutation = useMutation({
    mutationFn: createL0Rule,
    onSuccess: async () => {
      setNewRule(emptyRuleDraft);
      await queryClient.invalidateQueries({ queryKey: ['config-l0-rules'] });
      toast.success('L0 rule created');
    },
    onError: () => toast.error('Failed to create L0 rule'),
  });

  const updateRuleMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<L0RuleDraft> }) =>
      updateL0Rule(id, patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['config-l0-rules'] });
      toast.success('L0 rule updated');
    },
    onError: () => toast.error('Failed to update L0 rule'),
  });

  const deleteRuleMutation = useMutation({
    mutationFn: deleteL0Rule,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['config-l0-rules'] });
      toast.success('L0 rule deleted');
    },
    onError: () => toast.error('Failed to delete L0 rule'),
  });

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

  const l1ModelPredictions = useMemo(
    () =>
      buildModelPredictions(
        security.l1_scorer_model ?? '',
        configuredProviderNames,
        modelsCatalog,
      ),
    [configuredProviderNames, modelsCatalog, security.l1_scorer_model],
  );

  return (
    <div className="space-y-6">
      <SectionIssues issues={issues} />

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4" />
            {t('config.forms.security.l1Title')}
          </CardTitle>
          <CardDescription>
            {t('config.forms.security.l1Description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label={t('config.forms.security.l1Model')}>
            <SuggestionInput
              placeholder="openai/gpt-4o-mini"
              suggestions={l1ModelPredictions}
              value={security.l1_scorer_model ?? ''}
              onChange={(nextModel) =>
                updateValue({
                  ...security,
                  l1_scorer_model: nextModel || undefined,
                })
              }
            />
          </Field>
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4" />
            L0 static rules
          </CardTitle>
          <CardDescription>
            Manage deterministic command, path, and network rules loaded by
            agentd. Current agentd L0 blocks only when action is set to block;
            warn rules are stored for audit/future compatibility.
            <span className="mt-1 block text-muted-foreground/80 text-xs">
              Changes are saved automatically. No manual save required.
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 rounded-md border p-3 md:grid-cols-[minmax(120px,0.8fr)_minmax(220px,2fr)_140px_120px_120px_auto] md:items-end">
            <div className="space-y-2">
              <Label htmlFor="l0-agent-id">Agent</Label>
              <Input
                id="l0-agent-id"
                value={newRule.agentId}
                onChange={(event) =>
                  setNewRule((current) => ({
                    ...current,
                    agentId: event.target.value,
                  }))
                }
                placeholder="global"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="l0-pattern">Pattern</Label>
              <Input
                id="l0-pattern"
                value={newRule.pattern}
                onChange={(event) =>
                  setNewRule((current) => ({
                    ...current,
                    pattern: event.target.value,
                  }))
                }
                placeholder="rm\\s+-rf\\s+/"
              />
            </div>
            <RuleSelect
              label="Type"
              value={newRule.type}
              values={['command', 'path', 'network']}
              onValueChange={(type) =>
                setNewRule((current) => ({
                  ...current,
                  type: type as L0RuleType,
                }))
              }
            />
            <RuleSelect
              label="Action"
              value={newRule.action}
              values={['block', 'warn']}
              onValueChange={(action) =>
                setNewRule((current) => ({
                  ...current,
                  action: action as L0RuleAction,
                }))
              }
            />
            <RuleSelect
              label="Scope"
              value={newRule.scope}
              values={['global', 'workspace']}
              onValueChange={(scope) =>
                setNewRule((current) => ({
                  ...current,
                  scope: scope as L0RuleScope,
                }))
              }
            />
            <Button
              disabled={
                createRuleMutation.isPending ||
                !newRule.agentId.trim() ||
                !newRule.pattern.trim()
              }
              onClick={() =>
                createRuleMutation.mutate({
                  ...newRule,
                  agentId: newRule.agentId.trim(),
                  pattern: newRule.pattern.trim(),
                })
              }
            >
              {createRuleMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              Add
            </Button>
          </div>

          {l0RulesLoading ? (
            <div className="flex items-center justify-center rounded-md border p-8 text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              Loading L0 rules...
            </div>
          ) : !l0Rules || l0Rules.length === 0 ? (
            <div className="rounded-md border border-dashed p-8 text-center text-muted-foreground text-sm">
              No L0 rules configured yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[72px]">Enabled</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Pattern</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {l0Rules.map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell>
                      <Checkbox
                        aria-label={`Toggle L0 rule ${rule.pattern}`}
                        checked={rule.enabled}
                        disabled={updateRuleMutation.isPending}
                        onCheckedChange={(checked) =>
                          updateRuleMutation.mutate({
                            id: rule.id,
                            patch: { enabled: Boolean(checked) },
                          })
                        }
                      />
                    </TableCell>
                    <TableCell className="min-w-[120px]">
                      <Input
                        defaultValue={rule.agentId}
                        className="h-8 font-mono text-xs"
                        onBlur={(event) => {
                          const agentId = event.target.value.trim();
                          if (agentId && agentId !== rule.agentId) {
                            updateRuleMutation.mutate({
                              id: rule.id,
                              patch: { agentId },
                            });
                          }
                        }}
                      />
                    </TableCell>
                    <TableCell className="min-w-[240px]">
                      <Input
                        defaultValue={rule.pattern}
                        className="h-8 font-mono text-xs"
                        onBlur={(event) => {
                          const pattern = event.target.value.trim();
                          if (pattern && pattern !== rule.pattern) {
                            updateRuleMutation.mutate({
                              id: rule.id,
                              patch: { pattern },
                            });
                          }
                        }}
                      />
                    </TableCell>
                    <TableCell className="min-w-[130px]">
                      <RuleInlineSelect
                        value={rule.type}
                        values={['command', 'path', 'network']}
                        onValueChange={(type) =>
                          updateRuleMutation.mutate({
                            id: rule.id,
                            patch: { type: type as L0RuleType },
                          })
                        }
                      />
                    </TableCell>
                    <TableCell className="min-w-[120px]">
                      <RuleInlineSelect
                        value={rule.action}
                        values={['block', 'warn']}
                        onValueChange={(action) =>
                          updateRuleMutation.mutate({
                            id: rule.id,
                            patch: { action: action as L0RuleAction },
                          })
                        }
                      />
                      {rule.action === 'warn' ? (
                        <Badge variant="outline" className="mt-2 text-[10px]">
                          non-blocking
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="min-w-[120px]">
                      <RuleInlineSelect
                        value={rule.scope}
                        values={['global', 'workspace']}
                        onValueChange={(scope) =>
                          updateRuleMutation.mutate({
                            id: rule.id,
                            patch: { scope: scope as L0RuleScope },
                          })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        aria-label={`Delete L0 rule ${rule.pattern}`}
                        size="icon"
                        variant="ghost"
                        disabled={deleteRuleMutation.isPending}
                        onClick={() => deleteRuleMutation.mutate(rule.id)}
                      >
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RuleSelect({
  label,
  onValueChange,
  value,
  values,
}: {
  label: string;
  onValueChange: (value: string) => void;
  value: string;
  values: string[];
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map((item) => (
            <SelectItem key={item} value={item}>
              {item}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function RuleInlineSelect({
  onValueChange,
  value,
  values,
}: {
  onValueChange: (value: string) => void;
  value: string;
  values: string[];
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className="h-8">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {values.map((item) => (
          <SelectItem key={item} value={item}>
            {item}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
