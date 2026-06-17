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

// Realistic Chrome UA on a common desktop Linux config. The previous UA
// carried an `AgentBoster/1.0` token which loudly self-identified as a bot
// to any fingerprinting / risk-control system. Keep this in sync with the
// platform hinted at by the launch args below.
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
  profile: string;
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

type ProfileState = {
  // Serialized Playwright storage state (cookies + localStorage + indexedDB
  // origins, depending on Playwright version). Captured via
  // `context.storageState()` and replayed via `newContext({ storageState })`.
  // Kept in-process only: Vercel serverless has no durable disk. Same scope
  // as the existing page pool — callers who need cross-restart persistence
  // must re-authenticate or pipe this blob through their own KV store.
  storageState: unknown;
  updatedAt: number;
};

export class BrowserPool {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly pendingSessions = new Map<string, Promise<BrowserSession>>();
  private readonly profiles = new Map<string, ProfileState>();
  private readonly idleTtlMs: number;
  private readonly maxSessions: number;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(options: BrowserPoolOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  /**
   * Resolve a profile key for a session.
   *
   * Profile is the unit of browser-state isolation (cookies, localStorage).
   * It is intentionally independent of `sessionId` so a single agent can
   * hold multiple authenticated profiles in parallel (e.g. logged-in vs.
   * incognito), and so multiple agents can share one profile when intended.
   *
   * Resolution order: explicit `profile` arg → `agentName` → 'default'.
   */
  private resolveProfile(
    profile: string | undefined,
    context?: { agentName?: string },
  ): string {
    const explicit = profile?.trim();
    if (explicit) {
      return explicit;
    }

    const fromContext = context?.agentName?.trim();
    if (fromContext) {
      return `agent:${fromContext}`;
    }

    return 'default';
  }

  async getSession(
    sessionId?: string,
    options?: {
      profile?: string;
      context?: { agentName?: string };
      userAgent?: string;
    },
  ): Promise<BrowserSession> {
    const key = this.normalizeSessionId(sessionId);
    const profile = this.resolveProfile(options?.profile, options?.context);
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

    const created = this.createSession(key, profile, options?.userAgent);
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

  /**
   * Persist the current context's cookies + localStorage under the profile
   * key. Returns the captured state so callers (e.g. agentd) can mirror it
   * to durable storage if they want cross-restart survival.
   */
  async saveProfile(
    sessionId?: string,
    profileOverride?: string,
  ): Promise<{ profile: string; storageState: unknown } | null> {
    const key = this.normalizeSessionId(sessionId);
    const session = this.sessions.get(key);
    if (!session) {
      return null;
    }

    const profile = profileOverride?.trim() || session.profile;
    const storageState = await session.context.storageState();
    this.profiles.set(profile, {
      storageState,
      updatedAt: Date.now(),
    });

    logger.info('profile:save', { sessionId: key, profile });
    return { profile, storageState };
  }

  /**
   * Hydrate a profile from an externally-supplied storage state (e.g. a
   * blob previously mirrored to KV by agentd). Useful when the in-process
   * profile cache has been wiped by a serverless restart.
   */
  setProfile(profile: string, storageState: unknown): void {
    const trimmed = profile.trim();
    if (!trimmed) {
      return;
    }
    this.profiles.set(trimmed, {
      storageState,
      updatedAt: Date.now(),
    });
  }

  getProfile(profile: string): ProfileState | undefined {
    return this.profiles.get(profile.trim());
  }

  listProfiles(): Array<{ profile: string; updatedAt: number }> {
    return [...this.profiles.entries()].map(([profile, state]) => ({
      profile,
      updatedAt: state.updatedAt,
    }));
  }

  deleteProfile(profile: string): boolean {
    return this.profiles.delete(profile.trim());
  }

  private async createSession(
    sessionId: string,
    profile: string,
    userAgentOverride?: string,
  ): Promise<BrowserSession> {
    await this.evictIfNeeded();

    const { chromium } = await import('playwright');
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-dev-shm-usage',
        // NOTE: --disable-gpu and --no-sandbox were dropped. They are a
        // well-known headless fingerprint combo and not required in the
        // Vercel/serverless runtime we run in. Keep the list tight and
        // only add flags that are actually necessary.
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    const storedProfile = this.profiles.get(profile);
    const contextOptions: Parameters<Browser['newContext']>[0] = {
      viewport: DEFAULT_VIEWPORT,
      userAgent: userAgentOverride?.trim() || DEFAULT_USER_AGENT,
    };
    if (storedProfile) {
      contextOptions.storageState =
        storedProfile.storageState as import('playwright').BrowserContextOptions['storageState'];
    }

    const context = await browser.newContext(contextOptions);

    // Best-effort anti-detection: mask the `navigator.webdriver` flag that
    // Cloudflare/Akamai look for. This runs after every navigation. It is
    // not a full stealth plugin (no canvas/webGL spoofing) — it just removes
    // the loudest signal. Full fingerprint randomization is out of scope for
    // the builtin browser; users who need it should run their own browser
    // MCP server.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true,
      });
    });

    const page = await context.newPage();
    const session: BrowserSession = {
      id: sessionId,
      profile,
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

    logger.info('session:create', {
      sessionId,
      profile,
      hydratedFromStorage: Boolean(storedProfile),
    });
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
      // Capture the profile snapshot before the context dies so the next
      // session on the same profile can resume logged-in. Best-effort — if
      // it throws we still drop the session.
      await this.saveProfile(session.id, session.profile).catch((error) => {
        logger.warn('profile:save_on_cleanup_failed', {
          sessionId: session.id,
          profile: session.profile,
          error: error instanceof Error ? error.message : String(error),
        });
      });

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

      await this.saveProfile(oldest.id, oldest.profile).catch((error) => {
        logger.warn('profile:save_on_evict_failed', {
          sessionId: oldest.id,
          profile: oldest.profile,
          error: error instanceof Error ? error.message : String(error),
        });
      });

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
