import { readVaultValue } from '@/lib/extra/vault';
import { createLogger } from '@/lib/utils/logger';
import type {
  KnowledgeProvider,
  KnowledgeProviderResult,
  KnowledgeProviderSearchInput,
} from './types';

const logger = createLogger('knowledge.provider.mem0');
const DEFAULT_MEM0_ENDPOINT = 'https://api.mem0.ai';
const MEM0_TIMEOUT_MS = 15_000;

type Mem0Config = {
  endpoint?: string;
  vaultKey?: string;
  userId?: string;
  agentId?: string;
  runType?: string;
};

function readMem0Config(config: Record<string, unknown>): Mem0Config {
  return {
    endpoint: typeof config.endpoint === 'string' ? config.endpoint : undefined,
    vaultKey: typeof config.vaultKey === 'string' ? config.vaultKey : undefined,
    userId: typeof config.userId === 'string' ? config.userId : undefined,
    agentId: typeof config.agentId === 'string' ? config.agentId : undefined,
    runType: typeof config.runType === 'string' ? config.runType : undefined,
  };
}

type Mem0MemoryEntry = {
  id?: string;
  memory?: string;
  score?: number;
  name?: string;
  user_id?: string;
  agent_id?: string;
  metadata?: Record<string, unknown>;
};

function mapMem0Results(entries: Mem0MemoryEntry[]): KnowledgeProviderResult[] {
  const results: KnowledgeProviderResult[] = [];
  for (const entry of entries) {
    const content = (entry.memory ?? '').toString().trim();
    if (!content) {
      continue;
    }
    const rawScore = typeof entry.score === 'number' ? entry.score : null;
    const score =
      rawScore === null
        ? undefined
        : Math.max(0, Math.min(1, Number.isFinite(rawScore) ? rawScore : 0));
    results.push({
      content,
      title: typeof entry.name === 'string' ? entry.name : undefined,
      remoteId: typeof entry.id === 'string' ? entry.id : undefined,
      score,
      sourceUri: undefined,
    });
  }
  return results;
}

export const mem0Provider: KnowledgeProvider = {
  name: 'mem0',

  async search(
    input: KnowledgeProviderSearchInput,
  ): Promise<KnowledgeProviderResult[]> {
    const cfg = readMem0Config(input.config);
    if (!cfg.vaultKey) {
      logger.warn('search:missing_vault_key');
      return [];
    }

    const endpoint = cfg.endpoint?.trim() || DEFAULT_MEM0_ENDPOINT;
    const searchUrl = `${endpoint.replace(/\/$/, '')}/v1/memories/search/`;

    const secret = await readVaultValue({ key: cfg.vaultKey });
    if (!secret) {
      logger.warn('search:vault_key_not_found', { vaultKey: cfg.vaultKey });
      return [];
    }

    const body: Record<string, unknown> = {
      query: input.query,
      limit: input.limit,
    };
    if (cfg.userId) {
      body.user_id = cfg.userId;
    }
    if (cfg.agentId) {
      body.agent_id = cfg.agentId;
    }
    if (cfg.runType) {
      body.run_type = cfg.runType;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MEM0_TIMEOUT_MS);
    try {
      const response = await fetch(searchUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Token ${secret.value}`,
        },
        body: JSON.stringify(body),
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
      const entries = Array.isArray(payload)
        ? (payload as Mem0MemoryEntry[])
        : Array.isArray((payload as { results?: unknown })?.results)
          ? (payload as { results: Mem0MemoryEntry[] }).results
          : [];

      return mapMem0Results(entries);
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
