import type { AdapterName } from '@/types/config';

// ─── Notification Types ──────────────────────────────────────────────

export type NotificationType = 'decision' | 'completion';

export type NotificationStatus =
  | 'pending'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'fallback'
  | 'expired';

// ─── Decision Notification (L2 authorization) ────────────────────────

export interface DecisionNotification {
  type: 'decision';
  taskId: string;
  decisionId: string;
  title: string;
  body: string;
  options: string[];
  expiresAt: string; // ISO 8601
}

// ─── Completion Notification ─────────────────────────────────────────

export interface CompletionNotification {
  type: 'completion';
  taskId: string;
  status: 'completed' | 'failed' | 'cancelled';
  title: string;
  summary: string;
  details?: {
    subAgents?: number;
    filesChanged?: number;
    commits?: number;
    logsUrl?: string;
    error?: string;
  };
  channelFallback: AdapterName[];
}

export type NotificationPayload = DecisionNotification | CompletionNotification;

// ─── Notification Record (for DB persistence) ───────────────────────

export interface NotificationRecord {
  id: string;
  taskId: string;
  decisionId?: string;
  notificationType: NotificationType;
  payload: NotificationPayload;
  status: NotificationStatus;
  channel: AdapterName;
  targetChatId: string;
  targetUserId?: string;
  errorMessage?: string;
  sentAt?: string;
  deliveredAt?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── User Notification Preferences ──────────────────────────────────

export interface NotificationPreferences {
  userId: string;
  preferredChannel: AdapterName;
  fallbackChannels: AdapterName[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Channel Health Status ──────────────────────────────────────────

export interface ChannelHealth {
  channel: AdapterName;
  consecutiveFailures: number;
  lastError?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  healthy: boolean;
}

// ─── Send Result ────────────────────────────────────────────────────

export interface NotificationSendResult {
  success: boolean;
  channel: AdapterName;
  error?: string;
  messageId?: string;
}
