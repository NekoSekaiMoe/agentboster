import type { AdapterName } from '@/types/config';

// ─── Notification Types ──────────────────────────────────────────────

export type NotificationType = 'decision' | 'completion' | 'l2_time_input';

export type NotificationStatus =
  | 'pending'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'fallback'
  | 'expired';

// ─── L2 Authorization ────────────────────────────────────────────────

export type L2Action = 'pass_once' | 'pass_until' | 'reject_once' | 'reject_until';

export interface L2DecisionContext {
  action: L2Action;
  taskId: string;
  decisionId: string;
  awaitingTimeInput: boolean;
  expiresAt?: string;
  createdAt: string;
}

// ─── Decision Notification (L2 authorization) ────────────────────────

export interface DecisionNotification {
  type: 'decision';
  taskId: string;
  decisionId: string;
  title: string;
  body: string;
  command: string;
  score: number;
  reason: string;
  options: L2Action[];
  expiresAt: string;
}

// ─── L2 Time Input Notification ──────────────────────────────────────

export interface L2TimeInputNotification {
  type: 'l2_time_input';
  taskId: string;
  decisionId: string;
  action: 'pass_until' | 'reject_until';
  title: string;
  command: string;
  promptMessage: string;
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

export type NotificationPayload = DecisionNotification | CompletionNotification | L2TimeInputNotification;

// ─── L2 Confirm Request ──────────────────────────────────────────────

export interface L2ConfirmRequest {
  taskId: string;
  decisionId: string;
  action: L2Action;
  timeInput?: string;
  chatId: string;
  userId?: string;
}

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
