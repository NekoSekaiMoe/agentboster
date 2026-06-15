import { httpProvider } from './http';
import { mem0Provider } from './mem0';
import type {
  KnowledgeProvider,
  KnowledgeProviderName,
  KnowledgeProviderResult,
  KnowledgeProviderSearchInput,
} from './types';

export type {
  KnowledgeProvider,
  KnowledgeProviderName,
  KnowledgeProviderResult,
  KnowledgeProviderSearchInput,
};

const registry = new Map<KnowledgeProviderName, KnowledgeProvider>([
  ['mem0', mem0Provider],
  ['http', httpProvider],
]);

export function registerKnowledgeProvider(
  name: KnowledgeProviderName,
  provider: KnowledgeProvider,
) {
  registry.set(name, provider);
}

export function getKnowledgeProvider(
  name: KnowledgeProviderName,
): KnowledgeProvider | null {
  return registry.get(name) ?? null;
}

export async function searchWithProvider(
  name: KnowledgeProviderName,
  input: KnowledgeProviderSearchInput,
): Promise<KnowledgeProviderResult[]> {
  const provider = getKnowledgeProvider(name);
  if (!provider) {
    return [];
  }
  try {
    return await provider.search(input);
  } catch {
    return [];
  }
}
