import type { L2AuthorizationWindow } from '../../auth/types';

export type L2Severity = 'high' | 'critical';

export interface L2AuthRequest {
  id: string;
  action: string;
  risk: {
    level: string;
    score: number;
    reasoning: string;
  };
  severity: L2Severity;
  expiresAt: number;
  timestamp: number;
  channelId: string;
  userId: string;
}

export interface L2AuthResponse {
  requestId: string;
  authorized: boolean;
  window?: L2AuthorizationWindow;
  rejectedReason?: string;
}

export interface IL2AuthManager {
  requestAuthorization(req: L2AuthRequest): Promise<void>;
  handleResponse(resp: L2AuthResponse): Promise<void>;
  isAuthorized(action: string, window: L2AuthorizationWindow): boolean;
  revokeSession(userId: string): void;
}
