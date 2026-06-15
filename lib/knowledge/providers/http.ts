import { readVaultValue } from '@/lib/vault';
import { createLogger } from '@/lib/utils/logger';
import type {
  KnowledgeProvider,
  KnowledgeProviderResult,
  KnowledgeProviderSearchInput,
} from './types';

const logger = createLogger('knowledge.provider.http');
const HTTP_TIMEOUT_MS = 15_000;

type HttpProviderConfig = {
  endpoint?: string;
  method?: string;
  vaultKey?: string;
  headersTemplate?: Record<string, string>;
  bodyTemplate?: Record<string, unknown>;
  responseMapping?: ResponseMapping;
};

type ResponseMapping = {
  resultsPath?: string;
  contentPath?: string;
  titlePath?: string;
  scorePath?: string;
  idPath?: string;
  sourceUriPath?: string;
};

const DEFAULT_MAPPING: Required<ResponseMapping> = {
  resultsPath: '',
  contentPath: 'content',
  titlePath: 'title',
  scorePath: 'score',
  idPath: 'id',
  sourceUriPath: 'source_uri',
};

function readHttpConfig(config: Record<string, unknown>): HttpProviderConfig {
  return {
    endpoint: typeof config.endpoint === 'string' ? config.endpoint : undefined,
    method: typeof config.method === 'string' ? config.method : undefined,
    vaultKey: typeof config.vaultKey === 'string' ? config.vaultKey : undefined,
    headersTemplate:
      typeof config.headersTemplate === 'object' &&
      config.headersTemplate !== null
        ? (config.headersTemplate as Record<string, string>)
        : undefined,
    bodyTemplate:
      typeof config.bodyTemplate === 'object' && config.bodyTemplate !== null
        ? (config.bodyTemplate as Record<string, unknown>)
        : undefined,
    responseMapping:
      typeof config.responseMapping === 'object' &&
      config.responseMapping !== null
        ? (config.responseMapping as ResponseMapping)
        : undefined,
  };
}

const PLACEHOLDER_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

function substitutePlaceholders(
  value: string,
  vars: Record<string, string>,
): string {
  return value.replace(PLACEHOLDER_PATTERN, (_, name: string) => {
    return vars[name] ?? '';
  });
}

function applyTemplate(
  template: Record<string, unknown> | undefined,
  vars: Record<string, string>,
): Record<string, unknown> | undefined {
  if (!template) {
    return undefined;
  }
  return JSON.parse(
    substitutePlaceholders(JSON.stringify(template), vars),
  ) as Record<string, unknown>;
}

function pickPath(value: unknown, path: string): unknown {
  if (!path || value === null || value === undefined) {
    return value;
  }
  const segments = path
    .split(/[.[\]]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  let current: unknown = value;
  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isFinite(index)) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

function extractResults(
  payload: unknown,
  mapping: Required<ResponseMapping>,
): KnowledgeProviderResult[] {
  const list = pickPath(payload, mapping.resultsPath);
  if (!Array.isArray(list)) {
    return [];
  }
  const results: KnowledgeProviderResult[] = [];
  for (const entry of list) {
    const content = pickPath(entry, mapping.contentPath);
    if (typeof content !== 'string' || content.trim().length === 0) {
      continue;
    }
    const rawScore = pickPath(entry, mapping.scorePath);
    const score =
      typeof rawScore === 'number' && Number.isFinite(rawScore)
        ? Math.max(0, Math.min(1, rawScore))
        : undefined;
    const title = pickPath(entry, mapping.titlePath);
    const remoteId = pickPath(entry, mapping.idPath);
    const sourceUri = pickPath(entry, mapping.sourceUriPath);
    results.push({
      content: content.trim(),
      title: typeof title === 'string' ? title : undefined,
      remoteId: typeof remoteId === 'string' ? remoteId : undefined,
      sourceUri: typeof sourceUri === 'string' ? sourceUri : undefined,
      score,
    });
  }
  return results;
}

export const httpProvider: KnowledgeProvider = {
  name: 'http',

  async search(
    input: KnowledgeProviderSearchInput,
  ): Promise<KnowledgeProviderResult[]> {
    const cfg = readHttpConfig(input.config);
    if (!cfg.endpoint) {
      logger.warn('search:missing_endpoint');
      return [];
    }

    let apiKey: string | undefined;
    if (cfg.vaultKey) {
      const secret = await readVaultValue({ key: cfg.vaultKey });
      if (!secret) {
        logger.warn('search:vault_key_not_found', {
          vaultKey: cfg.vaultKey,
        });
        return [];
      }
      apiKey = secret.value;
    }

    const vars: Record<string, string> = {
      QUERY: input.query,
      LIMIT: String(input.limit),
      API_KEY: apiKey ?? '',
    };

    const method = (cfg.method ?? 'POST').toUpperCase();
    const headers = applyTemplate(cfg.headersTemplate, vars) ?? {};
    const sanitizedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      sanitizedHeaders[key] = typeof value === 'string' ? value : String(value);
    }
    if (!sanitizedHeaders['Content-Type'] && method !== 'GET') {
      sanitizedHeaders['Content-Type'] = 'application/json';
    }

    const bodyVars = {
      ...vars,
      QUERY: input.query,
      LIMIT: String(input.limit),
    };
    const bodyTemplate = applyTemplate(cfg.bodyTemplate, bodyVars);

    const mapping: Required<ResponseMapping> = {
      ...DEFAULT_MAPPING,
      ...(cfg.responseMapping ?? {}),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(cfg.endpoint, {
        method,
        headers: sanitizedHeaders,
        body: method === 'GET' ? undefined : JSON.stringify(bodyTemplate ?? {}),
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.warn('search:request_failed', {
          status: response.status,
          statusText: response.statusText,
        });
        return [];
      }

      const payload = (await response.json()) as unknown;
      return extractResults(payload, mapping);
    } catch (error) {
      logger.warn('search:error', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    } finally {
      clearTimeout(timeout);
    }
  },
};
