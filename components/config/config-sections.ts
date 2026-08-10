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
    key: 'devices',
    descriptionKey: 'config.sections.devices.description',
    titleKey: 'config.sections.devices.title',
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
    // CRUD-driven sections manage their own persistence — no config draft,
    // no floating save button.
    selfPersisted: true,
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
    key: 'workspaces',
    descriptionKey: 'config.sections.workspaces.description',
    titleKey: 'config.sections.workspaces.title',
    selfPersisted: true,
  },
  {
    key: 'experiments',
    descriptionKey: 'config.sections.experiments.description',
    titleKey: 'config.sections.experiments.title',
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
    selfPersisted: true,
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
  selfPersisted?: boolean;
}>;

export type ConfigSectionKey = (typeof configSections)[number]['key'];

export const CONFIG_LAST_SECTION_COOKIE = 'agentboster:config:last-section';

export function isConfigSectionKey(value: string): value is ConfigSectionKey {
  return configSections.some((section) => section.key === value);
}

export interface ConfigSectionMeta {
  descriptionKey: TranslationKey;
  key: ConfigSectionKey;
  titleKey: TranslationKey;
  /**
   * True for CRUD-driven sections that persist their own edits (users,
   * knowledge, workspaces) — the config draft / floating save button is
   * hidden for these.
   */
  selfPersisted: boolean;
}

export function getConfigSectionMeta(
  sectionKey: ConfigSectionKey,
): ConfigSectionMeta {
  const matchedSection = configSections.find(
    (section) => section.key === sectionKey,
  );

  if (!matchedSection) {
    throw new Error(`Unknown config section: ${sectionKey}`);
  }

  return {
    descriptionKey: matchedSection.descriptionKey,
    key: matchedSection.key,
    titleKey: matchedSection.titleKey,
    selfPersisted:
      'selfPersisted' in matchedSection ? matchedSection.selfPersisted : false,
  };
}
