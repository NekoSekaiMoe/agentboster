'use client';

import { Bot, Languages } from 'lucide-react';

import { useI18n } from '@/components/i18n-provider';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { isLocale } from '@/lib/i18n';
import {
  botLocales,
  isBotLocale,
  type LanguageConfig,
} from '@/types/config/language';
import { useConfigContext } from '@/components/config/config-provider';
import { useConfigSection } from '@/hooks/use-config-section';
import { SectionIssues } from './shared';

const DEFAULT_LANGUAGE_CONFIG: LanguageConfig = {
  bot_locale: 'auto',
};

const botLocaleLabels: Record<(typeof botLocales)[number], string> = {
  auto: 'Auto',
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文（台灣）',
  'zh-HK': '繁體中文（香港）',
  ja: '日本語',
  ko: '한국어',
};

export function LanguageForm() {
  const { issues, value, updateValue } = useConfigSection('language');
  const { isAdmin } = useConfigContext();
  const { locale, localeLabels, locales, setLocale, t } = useI18n();
  const languageConfig: LanguageConfig = {
    ...DEFAULT_LANGUAGE_CONFIG,
    ...value,
  };

  function updateLanguageConfig(patch: Partial<LanguageConfig>) {
    updateValue((current) => ({
      ...DEFAULT_LANGUAGE_CONFIG,
      ...current,
      ...patch,
    }));
  }

  return (
    <div className="space-y-6">
      <SectionIssues issues={issues} />

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Languages className="size-4" />
            {t('config.forms.language.webuiTitle')}
          </CardTitle>
          <CardDescription>
            {t('config.forms.language.webuiDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Select
            value={locale}
            onValueChange={(nextLocale) => {
              if (isLocale(nextLocale)) {
                setLocale(nextLocale);
              }
            }}
          >
            <SelectTrigger
              aria-label="WebUI language"
              className="w-full sm:w-72"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-72 overflow-y-auto">
              {locales.map((item) => (
                <SelectItem key={item} value={item}>
                  {localeLabels[item]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {isAdmin ? (
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="size-4" />
              {t('config.forms.language.botTitle')}
            </CardTitle>
            <CardDescription>
              {t('config.forms.language.botDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Select
              value={languageConfig.bot_locale}
              onValueChange={(botLocale) => {
                if (isBotLocale(botLocale)) {
                  updateLanguageConfig({ bot_locale: botLocale });
                }
              }}
            >
              <SelectTrigger
                aria-label="Bot language"
                className="w-full sm:w-72"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72 overflow-y-auto">
                {botLocales.map((item) => (
                  <SelectItem key={item} value={item}>
                    {botLocaleLabels[item]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
