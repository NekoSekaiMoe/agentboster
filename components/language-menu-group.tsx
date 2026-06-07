'use client';

import { Languages } from 'lucide-react';

import { useI18n } from '@/components/i18n-provider';
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import { isLocale } from '@/lib/i18n';

export function LanguageMenuGroup({
  iconClassName = 'mr-2 size-4',
}: {
  iconClassName?: string;
}) {
  const { locale, localeLabels, locales, setLocale, t } = useI18n();

  return (
    <>
      <DropdownMenuLabel>{t('common.language')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={locale}
        onValueChange={(value) => {
          if (isLocale(value)) {
            setLocale(value);
          }
        }}
      >
        {locales.map((item) => (
          <DropdownMenuRadioItem key={item} value={item}>
            <Languages className={iconClassName} />
            {localeLabels[item]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}
