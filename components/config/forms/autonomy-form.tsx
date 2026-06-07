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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useConfigSection } from '@/hooks/use-config-section';
import type { AutonomyConfig } from '@/types/config/autonomy';

import { Field, SectionIssues } from './shared';

export function AutonomyForm() {
  const { issues, value, updateValue } = useConfigSection('autonomy');
  const { t } = useI18n();
  const autonomy = (value ?? {
    level: 'supervised',
    max_steps: 20,
  }) as AutonomyConfig;

  return (
    <div className="space-y-6">
      <SectionIssues issues={issues} />

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">
            {t('config.forms.autonomy.title')}
          </CardTitle>
          <CardDescription>
            {t('config.forms.autonomy.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label={t('config.forms.autonomy.level')}>
            <Select
              value={autonomy.level}
              onValueChange={(nextValue) =>
                updateValue({
                  ...autonomy,
                  level: nextValue as AutonomyConfig['level'],
                })
              }
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={t('config.forms.autonomy.chooseLevel')}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="supervised">supervised</SelectItem>
                <SelectItem value="full">full</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label={t('config.forms.autonomy.maxSteps')}>
            <Input
              min="0"
              type="number"
              value={autonomy.max_steps}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                updateValue({
                  ...autonomy,
                  max_steps: Number.isNaN(parsed) ? 0 : parsed,
                });
              }}
            />
          </Field>
        </CardContent>
      </Card>
    </div>
  );
}
