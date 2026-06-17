import { enUS } from './en-US';

export const enGB = {
  ...enUS,
  'appearance.language.description':
    'Choose the language used by navigation, settings and shared controls.',
  'config.sections.appearance.description':
    'Customise navigation style and display preferences.',
  'config.sections.models.description':
    'Set default models, provider endpoints and token limits.',
} satisfies Record<keyof typeof enUS, string>;
