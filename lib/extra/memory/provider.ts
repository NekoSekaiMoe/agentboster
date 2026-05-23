import type { IMemoryProvider, MemoryItem, MemoryQuery } from './types';

interface StoredMemory extends MemoryItem {
  sessionSummary?: boolean;
  sessionId?: string;
}

export class MemoryProvider implements IMemoryProvider {
  private memories = new Map<string, StoredMemory>();
  private sessionSummaries = new Map<string, string[]>();

  async store(
    item: Omit<MemoryItem, 'id' | 'accessCount'>,
  ): Promise<MemoryItem> {
    const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stored: StoredMemory = {
      ...item,
      id,
      accessCount: 0,
    };
    this.memories.set(id, stored);
    return this.toMemoryItem(stored);
  }

  async retrieve(query: MemoryQuery): Promise<MemoryItem[]> {
    let results = Array.from(this.memories.values());

    if (query.agentId) {
      results = results.filter((m) => m.agentId === query.agentId);
    }

    if (query.userId) {
      results = results.filter((m) => m.userId === query.userId);
    }

    if (query.keyword) {
      const keyword = query.keyword.toLowerCase();
      results = results.filter(
        (m) =>
          m.key.toLowerCase().includes(keyword) ||
          m.value.toLowerCase().includes(keyword) ||
          m.tags.some((t) => t.toLowerCase().includes(keyword)),
      );
    }

    results.sort((a, b) => {
      if (b.accessCount !== a.accessCount) {
        return b.accessCount - a.accessCount;
      }
      return b.updatedAt - a.updatedAt;
    });

    if (query.limit && query.limit > 0) {
      results = results.slice(0, query.limit);
    }

    for (const item of results) {
      item.accessCount += 1;
    }

    return results.map((m) => this.toMemoryItem(m));
  }

  async update(id: string, updates: Partial<MemoryItem>): Promise<void> {
    const existing = this.memories.get(id);
    if (!existing) throw new Error(`Memory not found: ${id}`);

    Object.assign(existing, updates, { updatedAt: Date.now() });
  }

  async delete(id: string): Promise<void> {
    this.memories.delete(id);
  }

  async createSessionSummary(
    agentId: string,
    sessionId: string,
    summary: string,
  ): Promise<void> {
    const summaries = this.sessionSummaries.get(agentId) ?? [];
    summaries.push(summary);
    this.sessionSummaries.set(agentId, summaries);

    await this.store({
      agentId,
      userId: 'system',
      type: 'context',
      key: `session-summary:${sessionId}`,
      value: summary,
      tags: ['session', 'summary'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  async getSessionSummaries(
    agentId: string,
    limit?: number,
  ): Promise<string[]> {
    const summaries = this.sessionSummaries.get(agentId) ?? [];
    if (limit && limit > 0) {
      return summaries.slice(-limit);
    }
    return [...summaries];
  }

  private toMemoryItem(stored: StoredMemory): MemoryItem {
    return {
      id: stored.id,
      agentId: stored.agentId,
      userId: stored.userId,
      type: stored.type,
      key: stored.key,
      value: stored.value,
      tags: stored.tags,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      accessCount: stored.accessCount,
    };
  }
}
