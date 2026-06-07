'use client';

import { useI18n } from '@/components/i18n-provider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { isLocale } from '@/lib/i18n';

export function AppearanceForm() {
  const { locale, localeLabels, locales, setLocale, t } = useI18n();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('appearance.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <div>
              <div className="font-medium text-sm">
                {t('appearance.language.title')}
              </div>
              <p className="text-muted-foreground text-sm">
                {t('appearance.language.description')}
              </p>
            </div>
            <Select
              value={locale}
              onValueChange={(value) => {
                if (isLocale(value)) {
                  setLocale(value);
                }
              }}
            >
              <SelectTrigger
                aria-label={t('appearance.language.label')}
                className="w-full sm:w-64"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {locales.map((item) => (
                  <SelectItem key={item} value={item}>
                    {localeLabels[item]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
