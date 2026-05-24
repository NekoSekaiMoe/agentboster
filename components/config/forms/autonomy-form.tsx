'use client';

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
import type { AutonomyConfig } from '@/types/config/autonomy';

import { Field, SectionIssues } from './shared';

export function AutonomyForm() {
  const { issues, value, updateValue } = useConfigSection('autonomy');
  const autonomy = (value ?? {
    level: 'supervised',
    max_steps: 20,
  }) as AutonomyConfig;

  return (
    <div className="space-y-6">
      <SectionIssues issues={issues} />

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Autonomy policy</CardTitle>
          <CardDescription>
            Choose the operating mode and the per-conversation action limit.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Level">
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
                <SelectValue placeholder="Choose a level" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="supervised">supervised</SelectItem>
                <SelectItem value="full">full</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label="Max steps">
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
