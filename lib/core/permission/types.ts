/**
 * Unified tool-permission contract.
 *
 * Ported from ref/piwork `packages/contract/src/permissions.ts` (Apache-2.0)
 * with the piwork host-rpc surface stripped. Shared vocabulary for the
 * PermissionBroker decision chain (`broker.ts`) and the path-containment
 * resolver (`path-containment.ts`); intended consumers are the Web app,
 * the CLI/desktop shell, and agentd-side gating adapters.
 */

export type PermissionRisk = 'low' | 'medium' | 'high';

export type PermissionDecision = 'allow-once' | 'allow-session' | 'deny';

export type PermissionMode = 'ask' | 'accept-edits' | 'auto';

/** Classification produced by the shared path-containment resolver. */
export type PermissionPathRoot = 'workspace' | 'scratch' | 'external';

export interface PermissionRequest {
  id: string;
  sessionId: string;
  toolName: string;
  risk: PermissionRisk;
  /** Human-safe preview of the tool arguments (bounded, never secrets). */
  argsPreview: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
}

export type PermissionResolveOutcome =
  | 'allowed-once'
  | 'allowed-session'
  | 'persistent-policy'
  | 'denied'
  | 'timeout'
  | 'cancelled';

/** Session grants live in memory only; they never reach disk. */
export interface SessionToolGrant {
  sessionId: string;
  toolName: string;
  grantedAt: number;
}

/** Persistent grants are per (sessionId, toolName) and stored as JSON. */
export interface PersistentToolGrant {
  sessionId: string;
  toolName: string;
  decision: 'allow' | 'deny';
  updatedAt: number;
}

export type PermissionEvent =
  | { type: 'permission-request'; request: PermissionRequest }
  | {
      type: 'permission-resolved';
      requestId: string;
      outcome: PermissionResolveOutcome;
      /** Machine-readable audit vocabulary. All optional for back-compat. */
      errorCode?: string;
      /** Coarse decision classification: allow-family / deny-family / ask. */
      decision?: 'allow' | 'deny' | 'ask';
      riskLevel?: PermissionRisk;
      toolName?: string;
      sessionId?: string;
      /** ISO timestamp of resolution. */
      timestamp?: string;
    };

/** Pending authorization requests auto-deny after this timeout. */
export const PERMISSION_TIMEOUT_MS = 120_000;

/** Authorization dialogs never receive more than this many preview chars. */
export const ARGS_PREVIEW_MAX_CHARS = 2_000;

export function isPermissionRisk(value: unknown): value is PermissionRisk {
  return value === 'low' || value === 'medium' || value === 'high';
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'ask' || value === 'accept-edits' || value === 'auto';
}
