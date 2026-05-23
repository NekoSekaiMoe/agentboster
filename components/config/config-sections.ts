export const configSections = [
  {
    key: 'models',
    title: 'Models',
    description: 'Set default models, provider endpoints, and token limits.',
  },
  {
    key: 'agents',
    title: 'Agents',
    description: 'Configure named agents, prompts, and model overrides.',
  },
  {
    key: 'channels',
    title: 'Channels',
    description: 'Set up Slack, Teams, Google Chat, and Telegram.',
  },
  {
    key: 'autonomy',
    title: 'Autonomy',
    description: 'Control agent autonomy level and maximum steps.',
  },
  {
    key: 'tools',
    title: 'Tools',
    description: 'Toggle built-in tools and provide per-tool config.',
  },
  {
    key: 'mcp',
    title: 'MCP',
    description: 'Manage MCP remote servers and authentication headers.',
  },
  {
    key: 'agentd',
    title: 'Agent Daemon',
    description:
      'Manage remote Agent Daemon connections, certificates, and sandbox settings.',
  },
] as const satisfies ReadonlyArray<{
  description: string;
  key: string;
  title: string;
}>;

export type ConfigSectionKey = (typeof configSections)[number]['key'];

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
