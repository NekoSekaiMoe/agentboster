export type KnowledgeProviderName = 'mem0' | 'http';

export interface KnowledgeProviderSearchInput {
  query: string;
  limit: number;
  config: Record<string, unknown>;
}

export interface KnowledgeProviderResult {
  content: string;
  title?: string;
  sourceUri?: string;
  remoteId?: string;
  score?: number;
}

export interface KnowledgeProvider {
  name: KnowledgeProviderName;
  search(
    input: KnowledgeProviderSearchInput,
  ): Promise<KnowledgeProviderResult[]>;
}
