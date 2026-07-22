'use client';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useI18n } from '@/components/i18n-provider';
import { Input } from '@/components/ui/input';
import { useConfigSection } from '@/hooks/use-config-section';
import type { ExperimentsConfig } from '@/types/config/experiments';

import { Field, SectionIssues } from './shared';

export function ExperimentsForm() {
  const { issues, value, updateValue } = useConfigSection('experiments');
  const { t } = useI18n();
  // `experiments` is an optional config section; default to empty object
  // so the form renders with defaults when unset.
  const experiments: ExperimentsConfig = value ?? {};

  const distillation = experiments.skillDistillation ?? {
    enabled: false,
    toolCallThreshold: 8,
    preferClawHub: true,
    clawhubMinScore: 1.5,
  };

  function updateDistillation(
    patch: Partial<NonNullable<ExperimentsConfig['skillDistillation']>>,
  ) {
    updateValue({
      ...experiments,
      skillDistillation: { ...distillation, ...patch },
    });
  }
  return (
    <div className="space-y-6">
      <SectionIssues issues={issues} />

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">
            {t('config.forms.experiments.title')}
          </CardTitle>
          <CardDescription>
            {t('config.forms.experiments.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Skill Distillation */}
          <div className="space-y-4 rounded-lg border p-4">
            <label className="flex cursor-pointer items-start justify-between gap-4">
              <div className="space-y-1">
                <span className="font-medium text-sm">
                  {t('config.forms.experiments.skillDistillation')}
                </span>
                <p className="text-muted-foreground text-xs">
                  {t('config.forms.experiments.skillDistillationHint')}
                </p>
              </div>
              <input
                checked={distillation.enabled}
                className="mt-1 size-4 rounded border-input"
                onChange={(event) =>
                  updateDistillation({ enabled: event.target.checked })
                }
                type="checkbox"
              />
            </label>

            {distillation.enabled && (
              <div className="grid gap-4 md:grid-cols-2">
                <Field label={t('config.forms.experiments.toolCallThreshold')}>
                  <p className="text-muted-foreground text-xs">
                    {t('config.forms.experiments.toolCallThresholdHint')}
                  </p>
                  <Input
                    min="3"
                    type="number"
                    value={distillation.toolCallThreshold}
                    onChange={(event) => {
                      const parsed = Number(event.target.value);
                      if (!Number.isNaN(parsed)) {
                        updateDistillation({
                          toolCallThreshold: Math.max(3, Math.floor(parsed)),
                        });
                      }
                    }}
                  />
                </Field>

                <Field label={t('config.forms.experiments.clawhubMinScore')}>
                  <p className="text-muted-foreground text-xs">
                    {t('config.forms.experiments.clawhubMinScoreHint')}
                  </p>
                  <Input
                    min="0"
                    step="0.1"
                    type="number"
                    value={distillation.clawhubMinScore}
                    onChange={(event) => {
                      const parsed = Number(event.target.value);
                      if (!Number.isNaN(parsed)) {
                        updateDistillation({
                          clawhubMinScore: Math.max(0, parsed),
                        });
                      }
                    }}
                  />
                </Field>

                <label className="flex cursor-pointer items-start justify-between gap-4 md:col-span-2">
                  <div className="space-y-1">
                    <span className="font-medium text-sm">
                      {t('config.forms.experiments.preferClawHub')}
                    </span>
                    <p className="text-muted-foreground text-xs">
                      {t('config.forms.experiments.preferClawHubHint')}
                    </p>
                  </div>
                  <input
                    checked={distillation.preferClawHub}
                    className="mt-1 size-4 rounded border-input"
                    onChange={(event) =>
                      updateDistillation({
                        preferClawHub: event.target.checked,
                      })
                    }
                    type="checkbox"
                  />
                </label>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
