import type { TranslationKey } from '@/lib/i18n';

export const configSections = [
  {
    key: 'models',
    descriptionKey: 'config.sections.models.description',
    titleKey: 'config.sections.models.title',
  },
  {
    key: 'agents',
    descriptionKey: 'config.sections.agents.description',
    titleKey: 'config.sections.agents.title',
  },
  {
    key: 'chat',
    descriptionKey: 'config.sections.chat.description',
    titleKey: 'config.sections.chat.title',
  },
  {
    key: 'language',
    descriptionKey: 'config.sections.language.description',
    titleKey: 'config.sections.language.title',
  },
  {
    key: 'knowledge',
    descriptionKey: 'config.sections.knowledge.description',
    titleKey: 'config.sections.knowledge.title',
  },
  {
    key: 'channels',
    descriptionKey: 'config.sections.channels.description',
    titleKey: 'config.sections.channels.title',
  },
  {
    key: 'tts',
    descriptionKey: 'config.sections.tts.description',
    titleKey: 'config.sections.tts.title',
  },
  {
    key: 'autonomy',
    descriptionKey: 'config.sections.autonomy.description',
    titleKey: 'config.sections.autonomy.title',
  },
  {
    key: 'security',
    descriptionKey: 'config.sections.security.description',
    titleKey: 'config.sections.security.title',
  },
  {
    key: 'tools',
    descriptionKey: 'config.sections.tools.description',
    titleKey: 'config.sections.tools.title',
  },
  {
    key: 'mcp',
    descriptionKey: 'config.sections.mcp.description',
    titleKey: 'config.sections.mcp.title',
  },
  {
    key: 'agentd',
    descriptionKey: 'config.sections.agentd.description',
    titleKey: 'config.sections.agentd.title',
  },
  {
    key: 'monitoring',
    descriptionKey: 'config.sections.monitoring.description',
    titleKey: 'config.sections.monitoring.title',
  },
  {
    key: 'users',
    descriptionKey: 'config.sections.users.description',
    titleKey: 'config.sections.users.title',
  },
  {
    key: 'audit-logs',
    descriptionKey: 'config.sections.auditLogs.description',
    titleKey: 'config.sections.auditLogs.title',
  },
  {
    key: 'raw-json',
    descriptionKey: 'config.sections.rawJson.description',
    titleKey: 'config.sections.rawJson.title',
  },
] as const satisfies ReadonlyArray<{
  descriptionKey: TranslationKey;
  key: string;
  titleKey: TranslationKey;
}>;

export type ConfigSectionKey = (typeof configSections)[number]['key'];

export const CONFIG_LAST_SECTION_COOKIE = 'agentboster:config:last-section';

export function isConfigSectionKey(value: string): value is ConfigSectionKey {
  return configSections.some((section) => section.key === value);
}

export function getConfigSectionMeta(sectionKey: ConfigSectionKey) {
  const matchedSection = configSections.find(
    (section) => section.key === sectionKey,
  );

  if (!matchedSection) {
    throw new Error(`Unknown config section: ${sectionKey}`);
  }

  return matchedSection;
}
