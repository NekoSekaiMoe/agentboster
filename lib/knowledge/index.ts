import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { embedMany } from 'ai';

import {
  createKnowledgeBaseRow,
  createKnowledgeConnectorRow,
  createKnowledgeDocumentRow,
  canManageKnowledgeBaseRow,
  deleteKnowledgeBaseRow,
  deleteKnowledgeConnectorRow,
  deleteKnowledgeDocumentRow,
  getKnowledgeConnectorRow,
  getKnowledgeBaseRow,
  hashKnowledgeContent,
  hybridSearchKnowledgeChunks,
  listKnowledgeBaseRows,
  listKnowledgeConnectorRows,
  listKnowledgeDocumentRows,
  mergeKnowledgeCandidates,
  replaceKnowledgeDocumentChunks,
  resolveKnowledgeBaseRows,
  updateKnowledgeBasePriorityRow,
  updateKnowledgeConnectorSyncRow,
  type KnowledgeBaseRow,
  type KnowledgeAccessScope,
  type KnowledgeVisibility,
  type KnowledgeChunkInput,
  type KnowledgeSearchRow,
  type SearchCandidate,
} from '@/lib/core/db/knowledge';
import { getConfig } from '@/lib/core/kv/config';
import { generateEmbedding, resolveEmbeddingModel } from '@/lib/ai';
import { searchWithProvider } from '@/lib/knowledge/providers';
import type { KnowledgeProviderName } from '@/lib/knowledge/providers';
import { upsertVaultEntry } from '@/lib/vault';
import { createLogger } from '@/lib/utils/logger';
import type { AppConfig } from '@/types/config';

const logger = createLogger('knowledge');
const MAX_EXTERNAL_SOURCE_LENGTH = 1_000_000;
const MAX_EXTERNAL_REDIRECTS = 3;

type KnowledgeIndexing = {
  mode: 'embedded' | 'keyword_only_no_model' | 'keyword_only_embedding_failed';
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  warning: string | null;
};

function normalizeSourceType(
  value: unknown,
): 'text' | 'file' | 'url' | 'import' {
  return value === 'file' || value === 'url' || value === 'import'
    ? value
    : 'text';
}

function normalizeKnowledgePriority(value: unknown) {
  const priority = Number(value ?? 0);
  if (!Number.isFinite(priority)) {
    return 0;
  }

  return Math.max(-1000, Math.min(1000, Math.trunc(priority)));
}

function normalizeHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

function normalizeExternalUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported');
  }

  const host = normalizeHostname(parsed.hostname);
  const blocked =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);

  if (blocked) {
    throw new Error('Local or private network URLs are not allowed');
  }

  parsed.hash = '';
  return parsed.toString();
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }

  const [first, second] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19))
  );
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('::ffff:')
  ) {
    const mappedIpv4 = normalized.replace('::ffff:', '');
    return mappedIpv4 ? isBlockedIp(mappedIpv4) : true;
  }

  const firstSegment = Number.parseInt(normalized.split(':')[0] || '0', 16);
  return (
    Number.isNaN(firstSegment) ||
    (firstSegment >= 0xfc00 && firstSegment <= 0xfdff) ||
    (firstSegment >= 0xfe80 && firstSegment <= 0xfebf) ||
    (firstSegment >= 0xff00 && firstSegment <= 0xffff)
  );
}

function isBlockedIp(address: string): boolean {
  const ipVersion = isIP(address);
  if (ipVersion === 4) {
    return isBlockedIpv4(address);
  }
  if (ipVersion === 6) {
    return isBlockedIpv6(address);
  }
  return true;
}

async function assertExternalUrlAllowed(url: string) {
  const normalized = normalizeExternalUrl(url);
  const parsed = new URL(normalized);
  const host = normalizeHostname(parsed.hostname);

  if (isIP(host)) {
    if (isBlockedIp(host)) {
      throw new Error('Local or private network URLs are not allowed');
    }
    return normalized;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('Unable to resolve external URL host');
  }
  if (
    addresses.length === 0 ||
    addresses.some((record) => isBlockedIp(record.address))
  ) {
    throw new Error('Local or private network URLs are not allowed');
  }

  return normalized;
}

function htmlToText(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchExternalUrlText(url: string, redirectCount = 0) {
  const normalizedUrl = await assertExternalUrlAllowed(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(normalizedUrl, {
      headers: {
        Accept: 'text/html,text/plain,application/xhtml+xml,*/*;q=0.5',
        'User-Agent': 'AgentBoster-KnowledgeConnector/1.0',
      },
      redirect: 'manual',
      signal: controller.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      if (redirectCount >= MAX_EXTERNAL_REDIRECTS) {
        throw new Error('External document has too many redirects');
      }

      const location = response.headers.get('location');
      if (!location) {
        throw new Error('External document redirect is missing a location');
      }

      return fetchExternalUrlText(
        new URL(location, normalizedUrl).toString(),
        redirectCount + 1,
      );
    }

    if (!response.ok) {
      throw new Error(`Fetch failed with HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_EXTERNAL_SOURCE_LENGTH) {
      throw new Error('External document is too large');
    }

    const contentType = response.headers.get('content-type') ?? '';
    const raw = (await response.text()).slice(0, MAX_EXTERNAL_SOURCE_LENGTH);
    const text = contentType.includes('html') ? htmlToText(raw) : raw.trim();
    if (!text) {
      throw new Error('External document is empty');
    }

    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  input: {
    min: number;
    max: number;
  },
) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(
    input.min,
    Math.min(Math.trunc(value ?? fallback), input.max),
  );
}

function splitTextIntoChunks(input: {
  content: string;
  chunkSize: number;
  chunkOverlap: number;
}) {
  const content = input.content.trim();
  if (!content) {
    return [];
  }

  const chunkSize = clampInteger(input.chunkSize, 1000, {
    min: 200,
    max: 8000,
  });
  const chunkOverlap = clampInteger(input.chunkOverlap, 120, {
    min: 0,
    max: Math.floor(chunkSize / 2),
  });
  const chunks: Array<{ chunkIndex: number; content: string }> = [];
  let start = 0;

  while (start < content.length) {
    let end = Math.min(start + chunkSize, content.length);

    if (end < content.length) {
      const window = content.slice(start, end);
      const boundary = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('\n'),
        window.lastIndexOf(' '),
      );

      if (boundary > Math.floor(chunkSize * 0.55)) {
        end = start + boundary;
      }
    }

    const chunk = content.slice(start, end).trim();
    if (chunk) {
      chunks.push({ chunkIndex: chunks.length, content: chunk });
    }

    const nextStart = Math.max(end - chunkOverlap, start + 1);
    start = nextStart;
  }

  return chunks;
}

async function getEffectiveConfig(config?: AppConfig) {
  return config ?? (await getConfig());
}

async function buildIndexedChunks(input: {
  chunks: Array<{ chunkIndex: number; content: string }>;
  embeddingModel: string | null;
  config: AppConfig;
}): Promise<{
  chunks: KnowledgeChunkInput[];
  indexing: KnowledgeIndexing;
}> {
  if (!input.embeddingModel || input.chunks.length === 0) {
    return {
      chunks: input.chunks.map((chunk) => ({
        ...chunk,
        embedding: null,
        embeddingModel: null,
        embeddingDimensions: null,
      })),
      indexing: {
        mode: 'keyword_only_no_model',
        embeddingModel: null,
        embeddingDimensions: null,
        warning: null,
      },
    };
  }

  try {
    const model = resolveEmbeddingModel(input.embeddingModel, input.config);
    const { embeddings } = await embedMany({
      model,
      values: input.chunks.map((chunk) => chunk.content),
    });
    const embeddingDimensions = embeddings[0]?.length ?? null;

    return {
      chunks: input.chunks.map((chunk, index) => ({
        ...chunk,
        embedding: embeddings[index] ?? null,
        embeddingModel: input.embeddingModel,
        embeddingDimensions: embeddings[index]?.length ?? null,
      })),
      indexing: {
        mode: 'embedded',
        embeddingModel: input.embeddingModel,
        embeddingDimensions,
        warning: null,
      },
    };
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);

    logger.warn('index:embedding_failed', {
      embeddingModel: input.embeddingModel,
      warning,
    });

    return {
      chunks: input.chunks.map((chunk) => ({
        ...chunk,
        embedding: null,
        embeddingModel: null,
        embeddingDimensions: null,
      })),
      indexing: {
        mode: 'keyword_only_embedding_failed',
        embeddingModel: input.embeddingModel,
        embeddingDimensions: null,
        warning,
      },
    };
  }
}

export async function listKnowledgeBases(input?: {
  agentId?: string;
  includeDisabled?: boolean;
  access?: KnowledgeAccessScope;
  includeAllPrivate?: boolean;
}) {
  const rows = await listKnowledgeBaseRows(input);
  const access = input?.access;
  if (!access) {
    return rows;
  }

  return rows.map((row) => ({
    ...row,
    canManage: canManageKnowledgeBaseRow(row, access),
  }));
}

export async function createKnowledgeBase(input: {
  agentId?: string;
  ownerUserId?: string | null;
  visibility?: KnowledgeVisibility;
  kind?: 'local' | 'remote';
  name: string;
  description?: string | null;
  emoji?: string | null;
  embeddingModel?: string | null;
  chunkSize?: number;
  chunkOverlap?: number;
  priority?: number;
  config?: AppConfig;
}) {
  const effectiveConfig = await getEffectiveConfig(input.config);
  const kind = input.kind ?? 'local';
  const embeddingModel =
    kind === 'remote'
      ? null
      : (input.embeddingModel ??
        effectiveConfig.models?.embedding_model ??
        null);

  return createKnowledgeBaseRow({
    agentId: input.agentId,
    ownerUserId: input.ownerUserId,
    visibility: input.visibility,
    kind,
    name: input.name.trim(),
    description: input.description,
    emoji: input.emoji,
    embeddingModel,
    chunkSize: input.chunkSize,
    chunkOverlap: input.chunkOverlap,
    priority: normalizeKnowledgePriority(input.priority),
  });
}

export async function updateKnowledgeBase(input: {
  knowledgeBaseId: string;
  priority: number;
  access: KnowledgeAccessScope;
  includeAllPrivate?: boolean;
}) {
  await getManageableKnowledgeBase(input);
  const row = await updateKnowledgeBasePriorityRow({
    id: input.knowledgeBaseId,
    priority: normalizeKnowledgePriority(input.priority),
  });
  if (!row) {
    throw new Error(`Knowledge base ${input.knowledgeBaseId} not found`);
  }
  return row;
}

export async function listKnowledgeDocuments(
  knowledgeBaseId: string,
  options?: {
    access?: KnowledgeAccessScope;
    includeAllPrivate?: boolean;
  },
) {
  const knowledgeBase = await getKnowledgeBaseRow(knowledgeBaseId, {
    access: options?.access,
    includeAllPrivate: options?.includeAllPrivate,
  });
  if (!knowledgeBase) {
    throw new Error(`Knowledge base ${knowledgeBaseId} not found`);
  }

  return listKnowledgeDocumentRows(knowledgeBaseId);
}

export async function deleteKnowledgeBase(input: {
  knowledgeBaseId: string;
  access: KnowledgeAccessScope;
  includeAllPrivate?: boolean;
}) {
  const knowledgeBase = await getKnowledgeBaseRow(input.knowledgeBaseId, {
    access: input.access,
    includeAllPrivate: input.includeAllPrivate,
  });
  if (!knowledgeBase) {
    throw new Error(`Knowledge base ${input.knowledgeBaseId} not found`);
  }
  if (!canManageKnowledgeBaseRow(knowledgeBase, input.access)) {
    throw new Error('Forbidden');
  }

  return deleteKnowledgeBaseRow(input.knowledgeBaseId);
}

export async function deleteKnowledgeDocument(input: {
  knowledgeBaseId: string;
  documentId: string;
  access: KnowledgeAccessScope;
  includeAllPrivate?: boolean;
}) {
  const knowledgeBase = await getKnowledgeBaseRow(input.knowledgeBaseId, {
    access: input.access,
    includeAllPrivate: input.includeAllPrivate,
  });
  if (!knowledgeBase) {
    throw new Error(`Knowledge base ${input.knowledgeBaseId} not found`);
  }
  if (!canManageKnowledgeBaseRow(knowledgeBase, input.access)) {
    throw new Error('Forbidden');
  }

  const deleted = await deleteKnowledgeDocumentRow({
    knowledgeBaseId: input.knowledgeBaseId,
    documentId: input.documentId,
  });
  if (!deleted) {
    throw new Error(`Knowledge document ${input.documentId} not found`);
  }

  return deleted;
}

async function getManageableKnowledgeBase(input: {
  knowledgeBaseId: string;
  access: KnowledgeAccessScope;
  includeAllPrivate?: boolean;
}) {
  const knowledgeBase = await getKnowledgeBaseRow(input.knowledgeBaseId, {
    access: input.access,
    includeAllPrivate: input.includeAllPrivate,
  });
  if (!knowledgeBase) {
    throw new Error(`Knowledge base ${input.knowledgeBaseId} not found`);
  }
  if (!canManageKnowledgeBaseRow(knowledgeBase, input.access)) {
    throw new Error('Forbidden');
  }
  return knowledgeBase;
}

export async function listKnowledgeConnectors(
  knowledgeBaseId: string,
  options?: {
    access?: KnowledgeAccessScope;
    includeAllPrivate?: boolean;
  },
) {
  const knowledgeBase = await getKnowledgeBaseRow(knowledgeBaseId, {
    access: options?.access,
    includeAllPrivate: options?.includeAllPrivate,
  });
  if (!knowledgeBase) {
    throw new Error(`Knowledge base ${knowledgeBaseId} not found`);
  }

  return listKnowledgeConnectorRows(knowledgeBaseId);
}

type RemoteProviderConfig = {
  endpoint?: string;
  userId?: string;
  agentId?: string;
  runType?: string;
  method?: string;
  headersTemplate?: Record<string, string>;
  bodyTemplate?: Record<string, unknown>;
  responseMapping?: Record<string, string>;
};

function normalizeRemoteProviderConfig(
  raw: Record<string, unknown> | null | undefined,
): RemoteProviderConfig {
  if (!raw) {
    return {};
  }
  const picked: RemoteProviderConfig = {};
  if (typeof raw.endpoint === 'string') picked.endpoint = raw.endpoint;
  if (typeof raw.userId === 'string') picked.userId = raw.userId;
  if (typeof raw.agentId === 'string') picked.agentId = raw.agentId;
  if (typeof raw.runType === 'string') picked.runType = raw.runType;
  if (typeof raw.method === 'string') picked.method = raw.method;
  if (typeof raw.headersTemplate === 'object' && raw.headersTemplate) {
    picked.headersTemplate = raw.headersTemplate as Record<string, string>;
  }
  if (typeof raw.bodyTemplate === 'object' && raw.bodyTemplate) {
    picked.bodyTemplate = raw.bodyTemplate as Record<string, unknown>;
  }
  if (typeof raw.responseMapping === 'object' && raw.responseMapping) {
    picked.responseMapping = raw.responseMapping as Record<string, string>;
  }
  return picked;
}

function buildVaultKey(provider: string, knowledgeBaseId: string) {
  const safeId = knowledgeBaseId.replace(/[^a-zA-Z0-9_.:-]/g, '');
  return `knowledge:provider:${provider}:${safeId}`;
}

export async function createKnowledgeConnector(input: {
  knowledgeBaseId: string;
  name: string;
  sourceUri?: string;
  provider?: 'url' | 'mem0' | 'http';
  apiKey?: string;
  config?: Record<string, unknown> | null;
  access: KnowledgeAccessScope;
  includeAllPrivate?: boolean;
}) {
  const knowledgeBase = await getManageableKnowledgeBase(input);
  const provider = input.provider ?? 'url';

  if (provider === 'url') {
    if (!input.sourceUri) {
      throw new Error('source_uri is required for url provider');
    }
    const sourceUri = await assertExternalUrlAllowed(input.sourceUri);
    const connector = await createKnowledgeConnectorRow({
      knowledgeBaseId: input.knowledgeBaseId,
      provider,
      name: input.name.trim() || sourceUri,
      sourceUri,
      config: input.config ?? null,
    });

    return syncKnowledgeConnector({
      knowledgeBaseId: input.knowledgeBaseId,
      connectorId: connector.id,
      access: input.access,
      includeAllPrivate: input.includeAllPrivate,
    });
  }

  if (knowledgeBase.kind !== 'remote') {
    throw new Error(
      'Remote provider connectors can only be attached to a remote knowledge base',
    );
  }

  const sourceUri = input.sourceUri?.trim() || '';
  const vaultKey = buildVaultKey(provider, input.knowledgeBaseId);
  if (input.apiKey) {
    await upsertVaultEntry({
      key: vaultKey,
      value: input.apiKey,
      userId: input.access.userId ?? null,
    });
  }

  const providerConfig: Record<string, unknown> = {
    ...normalizeRemoteProviderConfig(input.config),
    vaultKey,
  };
  if (sourceUri) {
    providerConfig.endpoint = sourceUri;
  }

  const connector = await createKnowledgeConnectorRow({
    knowledgeBaseId: input.knowledgeBaseId,
    provider,
    name: input.name.trim() || provider,
    sourceUri: sourceUri || provider,
    config: providerConfig,
  });

  return {
    connector,
    document: null,
    chunkCount: 0,
    indexing: null,
  };
}

export async function syncKnowledgeConnector(input: {
  knowledgeBaseId: string;
  connectorId: string;
  access: KnowledgeAccessScope;
  includeAllPrivate?: boolean;
}) {
  await getManageableKnowledgeBase(input);
  const connector = await getKnowledgeConnectorRow({
    knowledgeBaseId: input.knowledgeBaseId,
    connectorId: input.connectorId,
  });
  if (!connector) {
    throw new Error(`Knowledge connector ${input.connectorId} not found`);
  }

  if (connector.provider !== 'url') {
    await updateKnowledgeConnectorSyncRow({
      connectorId: connector.id,
      status: 'idle',
      lastError: null,
      lastSyncedAt: new Date(),
    });
    return {
      connector,
      document: null,
      chunkCount: 0,
      indexing: null,
    };
  }

  await updateKnowledgeConnectorSyncRow({
    connectorId: connector.id,
    status: 'syncing',
    lastError: null,
  });

  try {
    const content = await fetchExternalUrlText(connector.sourceUri);
    const result = await addKnowledgeDocument({
      knowledgeBaseId: input.knowledgeBaseId,
      title: connector.name,
      content,
      sourceType: 'url',
      sourceUri: connector.sourceUri,
      metadata: {
        connectorId: connector.id,
        provider: connector.provider,
      },
      access: input.access,
      includeAllPrivate: input.includeAllPrivate,
    });

    if (connector.lastDocumentId) {
      await deleteKnowledgeDocumentRow({
        knowledgeBaseId: input.knowledgeBaseId,
        documentId: connector.lastDocumentId,
      });
    }

    const updated = await updateKnowledgeConnectorSyncRow({
      connectorId: connector.id,
      status: 'idle',
      lastDocumentId: result.document.id,
      lastError: null,
      lastSyncedAt: new Date(),
    });

    return {
      connector: updated,
      document: result.document,
      chunkCount: result.chunkCount,
      indexing: result.indexing,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateKnowledgeConnectorSyncRow({
      connectorId: connector.id,
      status: 'failed',
      lastError: message,
    });
    throw error;
  }
}

export async function deleteKnowledgeConnector(input: {
  knowledgeBaseId: string;
  connectorId: string;
  access: KnowledgeAccessScope;
  includeAllPrivate?: boolean;
}) {
  await getManageableKnowledgeBase(input);
  const connector = await deleteKnowledgeConnectorRow({
    knowledgeBaseId: input.knowledgeBaseId,
    connectorId: input.connectorId,
  });
  if (!connector) {
    throw new Error(`Knowledge connector ${input.connectorId} not found`);
  }

  if (connector.lastDocumentId) {
    await deleteKnowledgeDocumentRow({
      knowledgeBaseId: input.knowledgeBaseId,
      documentId: connector.lastDocumentId,
    });
  }

  return connector;
}

export async function addKnowledgeDocument(input: {
  knowledgeBaseId: string;
  title: string;
  content: string;
  sourceType?: 'text' | 'file' | 'url' | 'import';
  sourceUri?: string | null;
  metadata?: Record<string, unknown> | null;
  config?: AppConfig;
  access?: KnowledgeAccessScope;
  includeAllPrivate?: boolean;
}) {
  const knowledgeBase = await getKnowledgeBaseRow(input.knowledgeBaseId, {
    access: input.access,
    includeAllPrivate: input.includeAllPrivate,
  });
  if (!knowledgeBase) {
    throw new Error(`Knowledge base ${input.knowledgeBaseId} not found`);
  }
  if (input.access && !canManageKnowledgeBaseRow(knowledgeBase, input.access)) {
    throw new Error('Forbidden');
  }

  const config = await getEffectiveConfig(input.config);
  const chunks = splitTextIntoChunks({
    content: input.content,
    chunkSize: knowledgeBase.chunkSize,
    chunkOverlap: knowledgeBase.chunkOverlap,
  });

  if (chunks.length === 0) {
    throw new Error('Document content is empty');
  }

  const embeddingModel =
    knowledgeBase.embeddingModel ?? config.models?.embedding_model ?? null;
  const { chunks: indexedChunks, indexing } = await buildIndexedChunks({
    chunks,
    embeddingModel,
    config,
  });
  const document = await createKnowledgeDocumentRow({
    knowledgeBaseId: knowledgeBase.id,
    title: input.title.trim(),
    sourceType: normalizeSourceType(input.sourceType),
    sourceUri: input.sourceUri,
    contentHash: hashKnowledgeContent(input.content),
    metadata: {
      ...(input.metadata ?? {}),
      rawLength: input.content.length,
    },
  });

  await replaceKnowledgeDocumentChunks({
    knowledgeBaseId: knowledgeBase.id,
    documentId: document.id,
    chunks: indexedChunks,
  });

  return {
    document,
    chunkCount: indexedChunks.length,
    indexing,
  };
}

function selectSearchEmbeddingModel(input: {
  knowledgeBases: KnowledgeBaseRow[];
  config: AppConfig;
}) {
  return (
    input.knowledgeBases.find((knowledgeBase) => knowledgeBase.embeddingModel)
      ?.embeddingModel ??
    input.config.models?.embedding_model ??
    null
  );
}

type RemoteProviderConnector = {
  connectorId: string;
  provider: 'mem0' | 'http';
  config: Record<string, unknown> | null;
};

async function loadRemoteConnectorsForBases(
  knowledgeBaseIds: string[],
): Promise<Map<string, RemoteProviderConnector>> {
  const result = new Map<string, RemoteProviderConnector>();
  if (knowledgeBaseIds.length === 0) {
    return result;
  }
  for (const knowledgeBaseId of knowledgeBaseIds) {
    const rows = await listKnowledgeConnectorRows(knowledgeBaseId);
    const enabled = rows.find(
      (row) =>
        row.enabled && (row.provider === 'mem0' || row.provider === 'http'),
    );
    if (!enabled) {
      continue;
    }
    const provider: 'mem0' | 'http' =
      enabled.provider === 'mem0' ? 'mem0' : 'http';
    result.set(knowledgeBaseId, {
      connectorId: enabled.id,
      provider,
      config: enabled.config ?? {},
    });
  }
  return result;
}

async function searchRemoteKnowledge(input: {
  query: string;
  limit: number;
  knowledgeBases: KnowledgeBaseRow[];
  connectors: Map<string, RemoteProviderConnector>;
}): Promise<SearchCandidate[]> {
  const candidateLimit = Math.max(input.limit * 3, 10);
  const results = await Promise.all(
    input.knowledgeBases.map(async (kb) => {
      const connector = input.connectors.get(kb.id);
      if (!connector) {
        return [];
      }
      const providerResults = await searchWithProvider(
        connector.provider satisfies KnowledgeProviderName,
        {
          query: input.query,
          limit: candidateLimit,
          config: connector.config ?? {},
        },
      );
      return providerResults.map((result) => {
        const chunkId = `remote:${connector.connectorId}:${
          result.remoteId ?? hashKnowledgeContent(result.content).slice(0, 16)
        }`;
        const score = typeof result.score === 'number' ? result.score : 0.5;
        return {
          chunkId,
          knowledgeBaseId: kb.id,
          knowledgeBaseName: kb.name,
          knowledgeBasePriority: kb.priority,
          knowledgeBaseVisibility: kb.visibility,
          documentId: chunkId,
          documentTitle: result.title ?? kb.name,
          documentSourceType: 'import' as const,
          documentSourceUri: result.sourceUri ?? null,
          documentCreatedAt: new Date(),
          content: result.content,
          vectorScore: score,
          keywordScore: 0,
        } satisfies SearchCandidate;
      });
    }),
  );
  return results.flat();
}

export async function searchKnowledge(input: {
  query: string;
  agentId?: string;
  knowledgeBaseIds?: string[];
  knowledgeBaseNames?: string[];
  limit?: number;
  minConfidence?: number;
  config?: AppConfig;
  access?: KnowledgeAccessScope;
}): Promise<KnowledgeSearchRow[]> {
  const query = input.query.trim();
  if (!query) {
    return [];
  }

  const config = await getEffectiveConfig(input.config);
  const knowledgeBases = await resolveKnowledgeBaseRows({
    agentId: input.agentId,
    knowledgeBaseIds: input.knowledgeBaseIds,
    knowledgeBaseNames: input.knowledgeBaseNames,
    access: input.access,
  });
  const hasExplicitKnowledgeBaseFilter =
    (input.knowledgeBaseIds?.length ?? 0) > 0 ||
    (input.knowledgeBaseNames?.length ?? 0) > 0;

  if (hasExplicitKnowledgeBaseFilter && knowledgeBases.length === 0) {
    return [];
  }
  if (knowledgeBases.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(input.limit ?? 5, 20));
  const minConfidence = Math.max(0, input.minConfidence ?? 0);

  const localKbs = knowledgeBases.filter((kb) => kb.kind === 'local');
  const remoteKbs = knowledgeBases.filter((kb) => kb.kind === 'remote');

  const localBaseIds = localKbs.map((kb) => kb.id);
  const embeddingModel = selectSearchEmbeddingModel({
    knowledgeBases: localKbs,
    config,
  });

  let localRows: KnowledgeSearchRow[] = [];
  if (localKbs.length > 0) {
    if (!embeddingModel) {
      localRows = await hybridSearchKnowledgeChunks({
        searchText: query,
        minConfidence,
        limit,
        offset: 0,
        agentId: input.agentId,
        knowledgeBaseIds: localBaseIds,
      });
    } else {
      try {
        const queryEmbedding = await generateEmbedding(
          query,
          embeddingModel,
          config,
        );
        localRows = await hybridSearchKnowledgeChunks({
          searchText: query,
          queryEmbedding: queryEmbedding.embedding,
          queryEmbeddingModel: queryEmbedding.embeddingModel,
          queryEmbeddingDimensions: queryEmbedding.embeddingDimensions,
          minConfidence,
          limit,
          offset: 0,
          agentId: input.agentId,
          knowledgeBaseIds: localBaseIds,
        });
      } catch (error) {
        logger.warn('search:embedding_failed', {
          embeddingModel,
          error: error instanceof Error ? error.message : String(error),
        });

        localRows = await hybridSearchKnowledgeChunks({
          searchText: query,
          minConfidence,
          limit,
          offset: 0,
          agentId: input.agentId,
          knowledgeBaseIds: localBaseIds,
        });
      }
    }
  }

  if (remoteKbs.length === 0) {
    return localRows;
  }

  const remoteConnectors = await loadRemoteConnectorsForBases(
    remoteKbs.map((kb) => kb.id),
  );

  if (remoteKbs.every((kb) => !remoteConnectors.has(kb.id))) {
    return localRows;
  }

  const remoteCandidates = await searchRemoteKnowledge({
    query,
    limit,
    knowledgeBases: remoteKbs,
    connectors: remoteConnectors,
  });

  if (remoteCandidates.length === 0) {
    return localRows;
  }

  if (localRows.length === 0) {
    return mergeKnowledgeCandidates({
      vectorRows: [],
      keywordRows: [],
      remoteRows: remoteCandidates,
      minConfidence,
      limit,
      offset: 0,
    });
  }

  const localCandidates: SearchCandidate[] = localRows.map((row) => ({
    chunkId: row.chunkId,
    knowledgeBaseId: row.knowledgeBaseId,
    knowledgeBaseName: row.knowledgeBaseName,
    knowledgeBasePriority: row.knowledgeBasePriority,
    knowledgeBaseVisibility: row.knowledgeBaseVisibility,
    documentId: row.documentId,
    documentTitle: row.documentTitle,
    documentSourceType: row.documentSourceType,
    documentSourceUri: row.documentSourceUri,
    documentCreatedAt: row.documentCreatedAt,
    content: row.content,
    vectorScore: row.vectorScore,
    keywordScore: row.keywordScore,
  }));

  return mergeKnowledgeCandidates({
    vectorRows: localCandidates,
    keywordRows: [],
    remoteRows: remoteCandidates,
    minConfidence,
    limit,
    offset: 0,
  });
}
