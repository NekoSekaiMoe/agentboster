import type { AdapterName } from '@/types/config';
import type { Locale } from '@/lib/i18n';

// ─── Notification Types ──────────────────────────────────────────────

export type NotificationType =
  | 'decision'
  | 'completion'
  | 'tidy_report'
  | 'l2_time_input'
  | 'workspace_failover';

export type NotificationStatus =
  | 'pending'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'fallback'
  | 'expired';

// ─── L2 Authorization ────────────────────────────────────────────────

export type L2Action =
  | 'pass_once'
  | 'pass_until'
  | 'reject_once'
  | 'reject_until';

export interface L2DecisionContext {
  action: L2Action;
  taskId: string;
  decisionId: string;
  awaitingTimeInput: boolean;
  expiresAt?: string;
  createdAt: string;
}

/**
 * Locale that channel renderers should use when localizing this
 * notification's template text (button labels, field names, titles
 * produced from `titleKey`). Resolved by send-notification.ts from
 * the target user's most recent session.metadata.locale, falling
 * back to the global default. Optional — when absent, renderers
 * fall back to the global default locale.
 */
export type NotificationLocale = Locale;

// ─── Decision Notification (L2 authorization) ────────────────────────

export interface DecisionNotification {
  type: 'decision';
  taskId: string;
  decisionId: string;
  title: string;
  body: string;
  command: string;
  commandReview?: string;
  score: number;
  reason: string;
  options: L2Action[];
  expiresAt: string;
  /** Locale for template localization; falls back to global default if absent. */
  locale?: NotificationLocale;
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
  /** Locale for template localization; falls back to global default if absent. */
  locale?: NotificationLocale;
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
    downloadUrl?: string;
    downloadFiles?: string[];
    gitCommitHash?: string;
    gitCommitMessage?: string;
    gitCompareUrl?: string;
    insertions?: number;
    deletions?: number;
    /** Task summary snapshot attached by agentd on completion. */
    progress?: string;
    pending?: string[];
    knownIssues?: string[];
    decisions?: Array<{
      description: string;
      reason: string;
      alternatives?: string[];
    }>;
  };
  channelFallback: string[];
  /** Locale for template localization; falls back to global default if absent. */
  locale?: NotificationLocale;
}

// ─── Task Summary Tidy Report ────────────────────────────────────────

export interface TidyReportNotification {
  type: 'tidy_report';
  taskId: string;
  title: string;
  summary: string;
  summaryLastUpdated: string;
  suggestions: string[];
  mergeIds?: string[];
  deleteIds?: string[];
  updateIds?: Array<Record<string, unknown>>;
  resolvedPending?: string[];
  resolvedIssues?: string[];
}

// ─── Workspace Failover ──────────────────────────────────────────────
// M3.5: fired when a workspace's preferred node goes offline past the
// grace window and the workspace is migrated to a fresh node. The payload
// mirrors the shape adapters already fall back to (summary + details) so
// unknown-type renderers print a reasonable card without per-adapter code.

export interface WorkspaceFailoverNotification {
  type: 'workspace_failover';
  workspaceId: string;
  workspaceName: string;
  /** Node id that went offline (the one the long-lived container used to
   *  live on). Null when the node row was deleted entirely. */
  staleNodeId: string | null;
  reason: 'node_offline' | (string & {});
  title: string;
  summary: string;
  details?: {
    migratedAt: string;
    /** Bumped fencing generation; useful for diagnostics. */
    nodeGeneration?: number;
  };
  locale?: NotificationLocale;
}

export type NotificationPayload =
  | DecisionNotification
  | CompletionNotification
  | L2TimeInputNotification
  | WorkspaceFailoverNotification;

export type StoredNotificationPayload =
  | NotificationPayload
  | TidyReportNotification;

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
  payload: StoredNotificationPayload;
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
