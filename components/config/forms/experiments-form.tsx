'use client';

import { useEffect, useState } from 'react';

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
    curatorIntervalHours: 6,
  };

  function updateDistillation(
    patch: Partial<NonNullable<ExperimentsConfig['skillDistillation']>>,
  ) {
    updateValue({
      ...experiments,
      skillDistillation: { ...distillation, ...patch },
    });
  }

  // Transient string buffers for the numeric inputs. We keep the raw
  // editable string here (including intermediate values like "3." or ""),
  // and apply each field's minimum clamping / integer conversion only on
  // blur so the user can actually type. The controlled `distillation.*`
  // value stays as the source of truth and is mirrored back whenever it
  // changes from outside (e.g. config save).
  const thresholdText = useNumericInput({
    value: distillation.toolCallThreshold,
    onCommit: (n) => updateDistillation({ toolCallThreshold: n }),
    min: 3,
    integer: true,
  });
  const minScoreText = useNumericInput({
    value: distillation.clawhubMinScore,
    onCommit: (n) => updateDistillation({ clawhubMinScore: n }),
    min: 0,
  });
  const intervalText = useNumericInput({
    value: distillation.curatorIntervalHours,
    onCommit: (n) => updateDistillation({ curatorIntervalHours: n }),
    min: 0,
    integer: true,
  });
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
                    value={thresholdText.value}
                    onBlur={thresholdText.commit}
                    onChange={(event) => thresholdText.set(event.target.value)}
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
                    value={minScoreText.value}
                    onBlur={minScoreText.commit}
                    onChange={(event) => minScoreText.set(event.target.value)}
                  />
                </Field>

                <Field
                  label={t('config.forms.experiments.curatorIntervalHours')}
                >
                  <p className="text-muted-foreground text-xs">
                    {t('config.forms.experiments.curatorIntervalHoursHint')}
                  </p>
                  <Input
                    min="0"
                    type="number"
                    value={intervalText.value}
                    onBlur={intervalText.commit}
                    onChange={(event) => intervalText.set(event.target.value)}
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

/**
 * Buffered numeric input. Keeps the raw editable string locally so the user
 * can type intermediate values like `""`, `"3."`, or `"0.5"` without the
 * controlled value fighting them (e.g. `Math.max(3, …)` clobbering a
 * partial input). Clamping + integer conversion happen on blur, and the
 * committed number is written back through `onCommit`. When the upstream
 * `value` changes externally, the buffer resyncs to it.
 */
function useNumericInput({
  value,
  onCommit,
  min = 0,
  integer = false,
}: {
  value: number;
  onCommit: (next: number) => void;
  min?: number;
  integer?: boolean;
}): { value: string; set: (next: string) => void; commit: () => void } {
  const [text, setText] = useState(String(value));

  // Resync the buffer when the upstream value changes (e.g. after a save).
  useEffect(() => {
    setText(String(value));
  }, [value]);

  function commit() {
    const parsed = Number(text);
    if (text.trim() === '' || Number.isNaN(parsed)) {
      // Invalid / empty input reverts to the floor (and notifies upstream
      // so the controlled value matches what we display).
      setText(String(min));
      if (value !== min) onCommit(min);
      return;
    }
    const clamped = Math.max(min, integer ? Math.floor(parsed) : parsed);
    const nextText = String(clamped);
    if (nextText !== text) setText(nextText);
    if (clamped !== value) onCommit(clamped);
  }

  return { value: text, set: setText, commit };
}
