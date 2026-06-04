import type { L2AuthorizationWindow } from '../../auth/types';
import type { IL2AuthManager, L2AuthRequest, L2AuthResponse } from './types';

interface AuthorizationEntry {
  action: string;
  window: L2AuthorizationWindow;
  grantedAt: number;
  expiresAt: number;
}

const WINDOW_DURATIONS: Record<L2AuthorizationWindow, number> = {
  once: 0,
  '10min': 10 * 60 * 1000,
  '1hour': 60 * 60 * 1000,
  '1day': 24 * 60 * 60 * 1000,
  session: Number.MAX_SAFE_INTEGER,
};

export class L2AuthManager implements IL2AuthManager {
  private pendingRequests = new Map<string, L2AuthRequest>();
  private authorizations = new Map<string, AuthorizationEntry[]>();
  private channelNotifier: ((req: L2AuthRequest) => Promise<void>) | null =
    null;

  setChannelNotifier(notifier: (req: L2AuthRequest) => Promise<void>): void {
    this.channelNotifier = notifier;
  }

  async requestAuthorization(req: L2AuthRequest): Promise<void> {
    this.pendingRequests.set(req.id, req);

    if (this.channelNotifier) {
      await this.channelNotifier(req);
    }
  }

  async handleResponse(resp: L2AuthResponse): Promise<void> {
    const pending = this.pendingRequests.get(resp.requestId);
    if (!pending) return;

    this.pendingRequests.delete(resp.requestId);

    if (resp.authorized && resp.window) {
      const now = Date.now();
      const duration = WINDOW_DURATIONS[resp.window] ?? 0;
      const expiresAt =
        pending.expiresAt > 0
          ? pending.expiresAt
          : duration === 0
            ? 0
            : now + duration;

      const entry: AuthorizationEntry = {
        action: pending.action,
        window: resp.window,
        grantedAt: now,
        expiresAt,
      };

      const userAuths = this.authorizations.get(pending.userId) ?? [];
      userAuths.push(entry);
      this.authorizations.set(pending.userId, userAuths);
    }
  }

  isAuthorized(
    userId: string,
    action: string,
    window: L2AuthorizationWindow,
  ): boolean {
    const now = Date.now();

    const entries = this.authorizations.get(userId);
    if (!entries) return false;

    for (const entry of entries) {
      if (entry.action !== action) continue;

      if (entry.window === 'session') return true;
      if (entry.window === 'once' && entry.grantedAt > 0) {
        entry.grantedAt = 0;
        return true;
      }
      if (entry.expiresAt > now) return true;
    }

    return false;
  }

  revokeSession(userId: string): void {
    this.authorizations.delete(userId);
  }

  getPendingRequests(): L2AuthRequest[] {
    return Array.from(this.pendingRequests.values());
  }

  clearExpiredAuthorizations(): void {
    const now = Date.now();
    for (const [userId, entries] of this.authorizations) {
      const valid = entries.filter(
        (e) => e.window === 'session' || e.expiresAt === 0 || e.expiresAt > now,
      );
      if (valid.length === 0) {
        this.authorizations.delete(userId);
      } else {
        this.authorizations.set(userId, valid);
      }
    }
  }
}
