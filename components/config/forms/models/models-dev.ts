import type { AIConfig } from '@/types/config/ai';
import { ofetch } from 'ofetch';

export type ModelsDevEntry = {
  id?: string;
  limit?: {
    context?: number;
    output?: number;
  };
};

export type ModelsDevProvider = {
  api?: string;
  models?: Record<string, ModelsDevEntry>;
};

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

const MODELS_DEV_API_URL = 'https://models.dev/api.json';
export const MAX_MODEL_SUGGESTIONS = 40;
let modelsDevCatalogCache: ModelsDevCatalog | null = null;
let modelsDevCatalogPromise: Promise<ModelsDevCatalog | null> | null = null;

export function createStableId(prefix: string) {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeLower(value: string) {
  return value.trim().toLowerCase();
}

export function splitProviderScopedModelId(modelId: string) {
  const separatorIndex = modelId.indexOf('/');

  if (separatorIndex <= 0) {
    return null;
  }

  return {
    providerName: modelId.slice(0, separatorIndex),
    providerModelId: modelId.slice(separatorIndex + 1),
  };
}

export function resolveCatalogProviderName(
  providerName: string,
  catalog: ModelsDevCatalog,
) {
  const normalized = normalizeLower(providerName);

  if (!normalized) {
    return null;
  }

  const match = Object.keys(catalog).find(
    (candidate) => normalizeLower(candidate) === normalized,
  );

  return match ?? null;
}

export function listProviderNames(catalog: ModelsDevCatalog | null) {
  if (!catalog) {
    return [] as string[];
  }

  return Object.keys(catalog).sort((left, right) => left.localeCompare(right));
}

export function listProviderModelIds(
  catalog: ModelsDevCatalog,
  providerName: string,
  configuredProviderName = providerName,
) {
  const provider = catalog[providerName];

  if (!provider?.models) {
    return [] as string[];
  }

  return Object.keys(provider.models)
    .map((modelId) => `${configuredProviderName}/${modelId}`)
    .sort((left, right) => left.localeCompare(right));
}

export function findModelLimit(catalog: ModelsDevCatalog, modelId: string) {
  const parsedModelId = splitProviderScopedModelId(modelId);

  if (!parsedModelId?.providerModelId) {
    return null;
  }

  const providerName = resolveCatalogProviderName(
    parsedModelId.providerName,
    catalog,
  );

  if (!providerName) {
    return null;
  }

  const entry = Object.entries(catalog[providerName]?.models ?? {}).find(
    ([candidateId]) =>
      normalizeLower(candidateId) ===
      normalizeLower(parsedModelId.providerModelId),
  )?.[1];

  return entry?.limit ?? null;
}

export function buildModelPredictions(
  inputValue: string,
  configuredProviderNames: string[],
  modelsCatalog: ModelsDevCatalog | null,
) {
  const normalizedInput = normalizeLower(inputValue);

  if (!inputValue.includes('/')) {
    return configuredProviderNames
      .map((providerName) => `${providerName}/`)
      .filter((providerId) =>
        normalizeLower(providerId).startsWith(normalizedInput),
      )
      .sort((left, right) => left.localeCompare(right))
      .slice(0, MAX_MODEL_SUGGESTIONS);
  }

  if (!modelsCatalog) {
    return [] as string[];
  }

  const parsedModelId = splitProviderScopedModelId(inputValue);

  if (!parsedModelId) {
    return [] as string[];
  }

  const configuredProvider = configuredProviderNames.find(
    (providerName) =>
      normalizeLower(providerName) ===
      normalizeLower(parsedModelId.providerName),
  );

  if (!configuredProvider) {
    return [] as string[];
  }

  const catalogProvider = resolveCatalogProviderName(
    configuredProvider,
    modelsCatalog,
  );

  if (!catalogProvider) {
    return [] as string[];
  }

  return listProviderModelIds(
    modelsCatalog,
    catalogProvider,
    configuredProvider,
  )
    .filter((candidate) =>
      normalizeLower(candidate).startsWith(normalizedInput),
    )
    .slice(0, MAX_MODEL_SUGGESTIONS);
}

export async function loadModelsDevCatalog() {
  if (modelsDevCatalogCache) {
    return modelsDevCatalogCache;
  }

  if (!modelsDevCatalogPromise) {
    modelsDevCatalogPromise = ofetch<ModelsDevCatalog>(MODELS_DEV_API_URL)
      .then((catalog) => {
        modelsDevCatalogCache = catalog;
        return catalog;
      })
      .catch(() => null)
      .finally(() => {
        modelsDevCatalogPromise = null;
      });
  }

  return modelsDevCatalogPromise;
}

/**
 * Build the full list of `provider/model-id` strings for every configured
 * provider, using the models.dev catalog as the source of truth for each
 * provider's model list.
 *
 * Used in two places:
 *  - Admin "allowed models" editor: as the suggestion source while typing.
 *  - User preferences combobox: as the fallback suggestion source when the
 *    admin has NOT set `models.allowed_models` (so users still get a
 *    useful list derived from whatever providers the admin configured).
 *
 * Provider names are matched case-insensitively against the catalog
 * (catalog keys are cased; configured provider keys may differ). Output
 * keeps the configured provider key as the prefix so the IDs round-trip
 * through the rest of the config system unchanged.
 *
 * Returns an empty array when the catalog is missing or none of the
 * configured providers appear in it.
 */
export function buildConfiguredProviderModelSuggestions(
  configuredProviderNames: string[],
  modelsCatalog: ModelsDevCatalog | null,
): string[] {
  if (!modelsCatalog || configuredProviderNames.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (const configuredName of configuredProviderNames) {
    const catalogName = resolveCatalogProviderName(
      configuredName,
      modelsCatalog,
    );
    if (!catalogName) continue;

    const providerModels = modelsCatalog[catalogName]?.models;
    if (!providerModels) continue;

    for (const modelId of Object.keys(providerModels)) {
      const scoped = `${configuredName}/${modelId}`;
      if (!seen.has(scoped)) {
        seen.add(scoped);
        result.push(scoped);
      }
    }
  }

  return result.sort((left, right) => left.localeCompare(right));
}

export function autoFillModelLimits(
  models: Partial<AIConfig>,
  modelsCatalog: ModelsDevCatalog | null,
  nextModel: string,
) {
  let contextLimit = models.context_limit;

  if (modelsCatalog) {
    const limit = findModelLimit(modelsCatalog, nextModel);

    if (limit) {
      if (contextLimit == null && typeof limit.context === 'number') {
        contextLimit = limit.context;
      }
    }
  }

  return {
    context_limit: contextLimit,
  };
}
