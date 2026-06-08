'use client';

import { ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useI18n } from '@/components/i18n-provider';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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

export function SecurityForm() {
  const { issues, value, updateValue } = useConfigSection('security');
  const { value: modelsValue } = useConfigSection('models');
  const { t } = useI18n();
  const security = (value ?? {}) as Partial<SecurityConfig>;
  const models = (modelsValue ?? {}) as Partial<AIConfig>;
  const [modelsCatalog, setModelsCatalog] = useState<ModelsDevCatalog | null>(
    null,
  );

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
    </div>
  );
}
