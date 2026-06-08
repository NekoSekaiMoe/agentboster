import { getConfig, patchConfig } from '@/lib/core/kv/config';
import {
  type AIConfig,
  type AIProvider,
  aiProviderConfigSchema,
  aiProviderEnum,
} from '@/types/config/ai';

type ProviderPatch = {
  api_key?: string;
  base_url?: string;
  format?: AIProvider;
  headers?: Record<string, string>;
  preset?: string;
};

const PROVIDER_SET_KEYS = new Set([
  'api_key',
  'base_url',
  'format',
  'preset',
  'header',
  'headers',
]);

function formatProviderList(
  providers: Record<string, { format: AIProvider; base_url?: string }> = {},
) {
  const entries = Object.entries(providers);
  if (entries.length === 0) {
    return 'No providers configured.';
  }

  return entries
    .map(([name, provider], index) => {
      const baseUrl = provider.base_url ? ` base_url=${provider.base_url}` : '';
      return `${index + 1}. ${name} format=${provider.format}${baseUrl}`;
    })
    .join('\n');
}

function formatProviderHelp() {
  return [
    'Provider commands:',
    '/provider - List providers',
    '/provider add <name> <format> [base_url] - Add a provider',
    '/provider set <name> format <openai|anthropic|google|openaicompatible>',
    '/provider set <name> base_url <url>',
    '/provider set <name> api_key <key>',
    '/provider set <name> header <key> <value>',
    '/provider remove <name> - Remove a provider',
  ].join('\n');
}

function parseSetArgs(args: string[]): ProviderPatch | null {
  const [key, ...rest] = args;
  const value = rest.join(' ').trim();

  if (!key || !PROVIDER_SET_KEYS.has(key)) {
    return null;
  }

  if (key === 'format') {
    const parsed = aiProviderEnum.safeParse(value);
    return parsed.success ? { format: parsed.data } : null;
  }

  if (key === 'header' || key === 'headers') {
    const [headerKey, ...headerValueParts] = rest;
    const headerValue = headerValueParts.join(' ').trim();
    if (!headerKey?.trim() || !headerValue) {
      return null;
    }
    return { headers: { [headerKey.trim()]: headerValue } };
  }

  if (!value) {
    return null;
  }

  return { [key]: value } as ProviderPatch;
}

export async function executeProviderCommand(args: string): Promise<string> {
  const trimmed = args.trim();
  const [action = '', rawName = '', ...rest] = trimmed.split(/\s+/);
  const config = await getConfig();
  const models: Partial<AIConfig> = config.models ?? {};
  const providers = models.providers ?? {};

  if (!trimmed || action === 'list') {
    return `${formatProviderList(providers)}\n\n${formatProviderHelp()}`;
  }

  if (action === 'help') {
    return formatProviderHelp();
  }

  const name = rawName.trim();
  if (!name) {
    return `Missing provider name.\n\n${formatProviderHelp()}`;
  }

  if (action === 'add') {
    if (providers[name]) {
      return `Provider "${name}" already exists. Use /provider set ${name} <field> <value> to update it.`;
    }

    const [rawFormat = 'openaicompatible', rawBaseUrl = ''] = rest;
    const parsedFormat = aiProviderEnum.safeParse(rawFormat);
    if (!parsedFormat.success) {
      return `Invalid provider format "${rawFormat}". Supported: ${aiProviderEnum.options.join(', ')}`;
    }

    const nextProvider = aiProviderConfigSchema.parse({
      format: parsedFormat.data,
      base_url: rawBaseUrl || undefined,
    });

    await patchConfig({
      models: {
        ...models,
        providers: {
          ...providers,
          [name]: nextProvider,
        },
      },
    });

    return `Provider "${name}" added.`;
  }

  if (action === 'set') {
    const existing = providers[name];
    if (!existing) {
      return `Provider "${name}" does not exist. Use /provider add ${name} <format> [base_url] first.`;
    }

    const patch = parseSetArgs(rest);
    if (!patch) {
      return `Invalid provider update.\n\n${formatProviderHelp()}`;
    }

    const nextProvider = aiProviderConfigSchema.parse({
      ...existing,
      ...patch,
      headers: patch.headers
        ? {
            ...(existing.headers ?? {}),
            ...patch.headers,
          }
        : existing.headers,
    });

    await patchConfig({
      models: {
        ...models,
        providers: {
          ...providers,
          [name]: nextProvider,
        },
      },
    });

    return `Provider "${name}" updated.`;
  }

  if (action === 'remove' || action === 'delete' || action === 'rm') {
    if (!providers[name]) {
      return `Provider "${name}" does not exist.`;
    }

    const nextProviders = { ...providers };
    delete nextProviders[name];

    await patchConfig({
      models: {
        ...models,
        providers: nextProviders,
      },
    });

    return `Provider "${name}" removed.`;
  }

  return `Unsupported provider action "${action}".\n\n${formatProviderHelp()}`;
}
