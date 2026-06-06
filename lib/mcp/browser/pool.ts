import { createLogger } from '@/lib/utils/logger';
import type { Browser, BrowserContext, Page } from 'playwright';

const logger = createLogger('mcp.browser.pool');

const DEFAULT_SESSION_ID = 'default';
const DEFAULT_VIEWPORT = {
  width: 1280,
  height: 720,
} as const;
const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 8;
const MAX_NETWORK_REQUESTS = 200;

export type BrowserNetworkRequest = {
  id: number;
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  failureText: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type BrowserSession = {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  createdAt: number;
  lastUsedAt: number;
  networkRequests: BrowserNetworkRequest[];
};

export type BrowserPoolOptions = {
  idleTtlMs?: number;
  maxSessions?: number;
};

export class BrowserPool {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly pendingSessions = new Map<string, Promise<BrowserSession>>();
  private readonly idleTtlMs: number;
  private readonly maxSessions: number;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(options: BrowserPoolOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  async getSession(sessionId?: string): Promise<BrowserSession> {
    const key = this.normalizeSessionId(sessionId);
    const current = this.sessions.get(key);

    if (current?.browser.isConnected()) {
      current.lastUsedAt = Date.now();
      return current;
    }

    if (current) {
      this.sessions.delete(key);
      await this.closeSession(current).catch((error) => {
        logger.warn('session:close_stale_failed', {
          sessionId: key,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    const pending = this.pendingSessions.get(key);
    if (pending) {
      return pending;
    }

    const created = this.createSession(key);
    this.pendingSessions.set(key, created);

    try {
      return await created;
    } finally {
      this.pendingSessions.delete(key);
    }
  }

  async close(sessionId?: string): Promise<boolean> {
    const key = this.normalizeSessionId(sessionId);
    const pending = this.pendingSessions.get(key);
    if (pending) {
      const session = await pending;
      this.pendingSessions.delete(key);
      this.sessions.delete(key);
      await this.closeSession(session);
      return true;
    }

    const session = this.sessions.get(key);
    if (!session) {
      return false;
    }

    this.sessions.delete(key);
    await this.closeSession(session);
    return true;
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    await Promise.allSettled(
      sessions.map((session) => this.closeSession(session)),
    );
  }

  getNetworkRequests(sessionId?: string): BrowserNetworkRequest[] {
    const key = this.normalizeSessionId(sessionId);
    return [...(this.sessions.get(key)?.networkRequests ?? [])];
  }

  private async createSession(sessionId: string): Promise<BrowserSession> {
    await this.evictIfNeeded();

    const { chromium } = await import('playwright');
    const browser = await chromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox'],
    });
    const context = await browser.newContext({
      viewport: DEFAULT_VIEWPORT,
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 AgentBoster/1.0',
    });
    const page = await context.newPage();
    const session: BrowserSession = {
      id: sessionId,
      browser,
      context,
      page,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      networkRequests: [],
    };

    this.attachNetworkListeners(session);
    this.sessions.set(sessionId, session);
    this.ensureCleanupTimer();

    logger.info('session:create', { sessionId });
    return session;
  }

  private attachNetworkListeners(session: BrowserSession): void {
    const requestIds = new WeakMap<object, number>();
    let nextRequestId = 1;

    session.page.on('request', (request) => {
      const id = nextRequestId++;
      requestIds.set(request, id);
      session.networkRequests.push({
        id,
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        status: null,
        failureText: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      });

      if (session.networkRequests.length > MAX_NETWORK_REQUESTS) {
        session.networkRequests.splice(
          0,
          session.networkRequests.length - MAX_NETWORK_REQUESTS,
        );
      }
    });

    session.page.on('response', (response) => {
      const id = requestIds.get(response.request());
      const entry = session.networkRequests.find(
        (request) => request.id === id,
      );
      if (!entry) {
        return;
      }

      entry.status = response.status();
      entry.finishedAt = new Date().toISOString();
    });

    session.page.on('requestfailed', (request) => {
      const id = requestIds.get(request);
      const entry = session.networkRequests.find((item) => item.id === id);
      if (!entry) {
        return;
      }

      entry.failureText = request.failure()?.errorText ?? 'Request failed';
      entry.finishedAt = new Date().toISOString();
    });
  }

  private ensureCleanupTimer(): void {
    if (this.cleanupTimer) {
      return;
    }

    this.cleanupTimer = setInterval(
      () => {
        void this.cleanupIdleSessions();
      },
      Math.min(this.idleTtlMs, 60_000),
    );
    this.cleanupTimer.unref?.();
  }

  private async cleanupIdleSessions(): Promise<void> {
    const cutoff = Date.now() - this.idleTtlMs;
    const staleSessions = [...this.sessions.values()].filter(
      (session) => session.lastUsedAt < cutoff,
    );

    for (const session of staleSessions) {
      this.sessions.delete(session.id);
      await this.closeSession(session).catch((error) => {
        logger.warn('session:cleanup_failed', {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    if (this.sessions.size === 0 && this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private async evictIfNeeded(): Promise<void> {
    while (this.sessions.size >= this.maxSessions) {
      const oldest = [...this.sessions.values()].sort(
        (left, right) => left.lastUsedAt - right.lastUsedAt,
      )[0];
      if (!oldest) {
        return;
      }

      this.sessions.delete(oldest.id);
      await this.closeSession(oldest);
    }
  }

  private async closeSession(session: BrowserSession): Promise<void> {
    await session.context.close().catch(() => undefined);
    await session.browser.close().catch(() => undefined);
    logger.info('session:close', { sessionId: session.id });
  }

  private normalizeSessionId(sessionId?: string): string {
    const trimmed = sessionId?.trim();
    return trimmed || DEFAULT_SESSION_ID;
  }
}

const globalForBrowserPool = globalThis as typeof globalThis & {
  __agentbosterBrowserPool?: BrowserPool;
};

export function getBrowserPool(): BrowserPool {
  globalForBrowserPool.__agentbosterBrowserPool ??= new BrowserPool();
  return globalForBrowserPool.__agentbosterBrowserPool;
}
