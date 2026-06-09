import { z } from 'zod';

export const botLocales = [
  'auto',
  'en-US',
  'en-GB',
  'zh-CN',
  'zh-TW',
  'zh-HK',
  'ja',
  'ko',
] as const;

export const botLocaleSchema = z.enum(botLocales);

export type BotLocale = z.infer<typeof botLocaleSchema>;

export function isBotLocale(value: string): value is BotLocale {
  return (botLocales as readonly string[]).includes(value);
}

export const languageConfigSchema = z.object({
  bot_locale: botLocaleSchema.default('auto'),
});

export type LanguageConfig = z.infer<typeof languageConfigSchema>;
