import { enUS } from './en-US';

export const enGB = {
  ...enUS,
  'appearance.language.description':
    'Choose the language used by navigation, settings and shared controls.',
  'config.sections.appearance.description':
    'Customise navigation style and display preferences.',
  'config.sections.models.description':
    'Set default models, provider endpoints and token limits.',
  'workspace.label': 'Workspace',
  'workspace.switch': 'Switch workspace',
  'workspace.createNew': 'New workspace',
  'workspace.defaultName': 'New workspace',
  'workspace.createSuccess': 'Workspace created',
  'workspace.createError': 'Failed to create workspace',
  'workspace.defaultWorkspaceName': 'Default workspace',
} satisfies Record<keyof typeof enUS, string>;
