export interface MemoryItem {
  id: string;
  agentId: string;
  userId: string;
  type: 'fact' | 'preference' | 'context';
  key: string;
  value: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  accessCount: number;
}

export interface MemoryQuery {
  agentId?: string;
  userId?: string;
  keyword?: string;
  limit?: number;
}

export interface IMemoryProvider {
  store(item: Omit<MemoryItem, 'id' | 'accessCount'>): Promise<MemoryItem>;
  retrieve(query: MemoryQuery): Promise<MemoryItem[]>;
  update(id: string, updates: Partial<MemoryItem>): Promise<void>;
  delete(id: string): Promise<void>;
  createSessionSummary(
    agentId: string,
    sessionId: string,
    summary: string,
  ): Promise<void>;
  getSessionSummaries(agentId: string, limit?: number): Promise<string[]>;
}
