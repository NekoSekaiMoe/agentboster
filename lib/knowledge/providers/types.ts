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
  /**
   * 信任来源(phase5-review B3):若 provider 能从对端 metadata 推断信任级别,
   * 填此处。adapter 优先用此值,默认缺省时按 tool_observed(最保守)。
   * mem0 按 metadata.trust / user_id 透传;http 按 responseMapping.sourceKindPath。
   */
  sourceKind?:
    | 'user_asserted'
    | 'assistant_observed'
    | 'tool_observed'
    | 'dream_consolidated'
    | 'dream_recombined';
}

export interface KnowledgeProvider {
  name: KnowledgeProviderName;
  search(
    input: KnowledgeProviderSearchInput,
  ): Promise<KnowledgeProviderResult[]>;
}
