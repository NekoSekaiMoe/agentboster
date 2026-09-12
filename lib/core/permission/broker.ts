/**
 * PermissionBroker — unified tool-permission decision authority.
 *
 * Ported from ref/piwork `packages/permissions/src/broker.ts` (Apache-2.0)
 * with two deviations, both documented inline:
 *  - No `node:crypto` import: the default id factory uses the WebCrypto
 *    global with a monotonic fallback (this module should stay importable
 *    from contexts where node:* modules are awkward, e.g. edge tooling).
 *  - The pending-key separator is `\0` (piwork concatenates sessionId and
 *    toolName with no separator, then slices by length — off by one and
 *    ambiguous when a toolName is a suffix of another; both sessionId and
 *    toolName validation forbid `\0`, so it is a safe delimiter here).
 *
 * Design invariants preserved from piwork (via vastsa):
 *  - evaluate() is an explicitly ordered pure function; order is
 *    security-sensitive (persistent deny is absolute, first).
 *  - Session grants are memory-only; only persistent grants reach disk.
 *  - Fail-closed edges everywhere: unknown risk → medium, unknown
 *    respond() decision → deny, timeout → deny, unavailable UI → deny.
 *  - Cancellation is authoritative: cancelSession/cancelAll win over any
 *    response that races in afterwards.
 *
 * NOTE: not wired into any runtime surface yet — a pure library with tests
 * (adopted scope). Integration targets: CLI/desktop approval gate, agentd
 * tool gating, web approval UI.
 */
import {
  ARGS_PREVIEW_MAX_CHARS,
  isPermissionMode,
  isPermissionRisk,
  PERMISSION_TIMEOUT_MS,
  type PermissionDecision,
  type PermissionMode,
  type PermissionPathRoot,
  type PermissionRequest,
  type PermissionResolveOutcome,
  type PermissionRisk,
  type PersistentToolGrant,
} from './types';

export type PermissionErrorCode =
  | 'TOOL_DENIED'
  | 'PERMISSION_TIMEOUT'
  | 'PERMISSION_UNAVAILABLE'
  | 'INVALID_PERMISSION_REQUEST';

export class PermissionError extends Error {
  readonly code: PermissionErrorCode;

  constructor(code: PermissionErrorCode, message: string) {
    super(message);
    this.name = 'PermissionError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Risk classification (fail-closed: unknown tools are medium, never low)
// ---------------------------------------------------------------------------

const LOW_RISK_TOOLS = new Set(['read', 'glob', 'grep', 'find', 'ls']);
const HIGH_RISK_TOOLS = new Set(['write', 'edit', 'bash']);

export function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

export function toolRisk(toolName: string): PermissionRisk {
  const tool = normalizeToolName(toolName);
  if (LOW_RISK_TOOLS.has(tool)) return 'low';
  if (HIGH_RISK_TOOLS.has(tool)) return 'high';
  return 'medium';
}

// ---------------------------------------------------------------------------
// Decision chain (pure)
// ---------------------------------------------------------------------------

export type EvaluateResult = 'allow-once' | 'allow-session' | 'ask' | 'deny';

/**
 * Ordered permission decision chain. Order is security-sensitive:
 *   1. persistent deny is absolute
 *   2. session grant -> allow-session
 *   3. persistent allow -> allow-session
 *   4. low risk -> allow-once (all modes)
 *   5. mode "auto" -> allow-once
 *   6. mode "accept-edits" -> allow-once for write/edit only
 *   7. otherwise -> ask (default-ask, NOT default-deny)
 */
export function evaluate(
  tool: string,
  risk: PermissionRisk,
  sessionGrants: ReadonlySet<string>,
  persistentGrant: PersistentToolGrant | undefined,
  mode: PermissionMode,
): EvaluateResult {
  const normalized = normalizeToolName(tool);
  if (persistentGrant?.decision === 'deny') return 'deny';
  if (sessionGrants.has(normalized)) return 'allow-session';
  if (persistentGrant?.decision === 'allow') return 'allow-session';
  if (risk === 'low') return 'allow-once';
  if (mode === 'auto') return 'allow-once';
  if (
    mode === 'accept-edits' &&
    (normalized === 'write' || normalized === 'edit')
  )
    return 'allow-once';
  return 'ask';
}

// ---------------------------------------------------------------------------
// Pending request management (serial queue, timeout, cancellation)
// ---------------------------------------------------------------------------

type Pending = {
  request: PermissionRequest;
  promise: Promise<'allow-once' | 'allow-session'>;
  resolve: (decision: 'allow-once' | 'allow-session') => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Session-only requests fail closed when the responder answers "allow-once". */
  sessionOnly: boolean;
  /** Cooldown bucket; defaults to the tool name. Related tools share one. */
  cooldownScope: string;
};

/** Audit fields the broker derives at finish(). */
export interface ResolvedAuditFields {
  errorCode?: string;
  decision?: 'allow' | 'deny' | 'ask';
  riskLevel?: PermissionRisk;
  toolName?: string;
  sessionId?: string;
  timestamp?: string;
}

export interface PermissionBrokerOptions {
  getPersistentGrant: (
    sessionId: string,
    toolName: string,
  ) => PersistentToolGrant | undefined;
  getSessionGrants: (sessionId: string) => ReadonlySet<string>;
  grantSession: (
    sessionId: string,
    toolName: string,
    source: 'user-prompt' | 'persistent-policy',
  ) => void;
  isResponderAvailable: () => boolean;
  emitRequest: (request: PermissionRequest) => void;
  emitResolved: (
    requestId: string,
    outcome: PermissionResolveOutcome,
    audit?: ResolvedAuditFields,
  ) => void;
  now?: () => number;
  createId?: () => string;
  timeoutMs?: number;
  denyCooldownMs?: number;
}

export interface PermissionRequestInput {
  sessionId: string;
  toolName: string;
  /** Caller-declared risk; invalid/unknown values are re-derived (fail-closed). */
  risk?: unknown;
  argsPreview: string;
  reason: string;
  mode?: unknown;
  /** Result of the shared path-containment resolver, when the tool is path-bound. */
  pathRoot?: PermissionPathRoot;
  /** Per-request timeout override, clamped to (0, the broker timeout]. */
  timeoutMs?: number;
  /**
   * When true, "allow-once" is meaningless for the domain (lease-based
   * grants) and is treated as an unknown decision: fail closed as deny.
   */
  sessionOnly?: boolean;
  /** Cooldown bucket shared across related tools. */
  cooldownScope?: string;
}

let fallbackCounter = 0;

function defaultCreateId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
  } catch {
    // fall through to the monotonic fallback
  }
  fallbackCounter += 1;
  return `perm-${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
}

/** `\0` cannot appear in a validated sessionId or toolName (see validators). */
function pendingKey(sessionId: string, toolName: string): string {
  return `${sessionId}\0${toolName}`;
}

function toolOfPendingKey(key: string): string {
  return key.slice(key.indexOf('\0') + 1);
}

export class PermissionBroker {
  private readonly pendingByKey = new Map<string, Pending>();
  private readonly pendingById = new Map<string, Pending>();
  private readonly queue: Pending[] = [];
  private active: Pending | null = null;
  private readonly deniedUntil = new Map<string, number>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly timeoutMs: number;
  private readonly denyCooldownMs: number;
  private readonly options: PermissionBrokerOptions;

  constructor(options: PermissionBrokerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? defaultCreateId;
    this.timeoutMs = options.timeoutMs ?? PERMISSION_TIMEOUT_MS;
    this.denyCooldownMs = options.denyCooldownMs ?? 2_000;
  }

  /**
   * Gate a tool call. Resolves with the granted decision, rejects with a
   * PermissionError on deny/timeout/cancel/unavailable-responder.
   */
  async request(
    input: PermissionRequestInput,
  ): Promise<'allow-once' | 'allow-session'> {
    const sessionId = validateSessionId(input.sessionId);
    const toolName = normalizeToolName(validateToolName(input.toolName));
    // Fail-closed risk: accept only a valid declared risk, else re-derive.
    const risk: PermissionRisk = isPermissionRisk(input.risk)
      ? input.risk
      : toolRisk(toolName);
    const mode: PermissionMode = isPermissionMode(input.mode)
      ? input.mode
      : 'ask';
    // External paths escalate: only an explicit grant or "auto" mode may
    // skip the prompt. The risk must escalate too — evaluate() short
    // -circuits `risk === 'low'` BEFORE consulting the mode, so an external
    // read (low-risk tool) would otherwise be allowed silently.
    const external = input.pathRoot === 'external';
    const effectiveMode: PermissionMode =
      external && mode !== 'auto' ? 'ask' : mode;
    const effectiveRisk: PermissionRisk = external ? 'high' : risk;

    const persistent = this.options.getPersistentGrant(sessionId, toolName);
    const decision = evaluate(
      toolName,
      effectiveRisk,
      this.options.getSessionGrants(sessionId),
      persistent,
      effectiveMode,
    );
    if (decision === 'allow-once') return 'allow-once';
    if (decision === 'allow-session') {
      this.options.grantSession(
        sessionId,
        toolName,
        persistent?.decision === 'allow' ? 'persistent-policy' : 'user-prompt',
      );
      return 'allow-session';
    }
    if (decision === 'deny') {
      throw new PermissionError(
        'TOOL_DENIED',
        `${toolName} is denied by the persistent policy`,
      );
    }

    // decision === "ask"
    const key = pendingKey(sessionId, toolName);
    const cooldownScope =
      typeof input.cooldownScope === 'string' && input.cooldownScope
        ? input.cooldownScope
        : toolName;
    const cooldownKey = pendingKey(sessionId, cooldownScope);
    if ((this.deniedUntil.get(cooldownKey) ?? 0) > this.now()) {
      throw new PermissionError(
        'TOOL_DENIED',
        `${toolName} was recently denied`,
      );
    }
    if (!this.options.isResponderAvailable()) {
      throw new PermissionError(
        'PERMISSION_UNAVAILABLE',
        'The authorization UI is unavailable',
      );
    }

    // Join an in-flight prompt for the same session+tool instead of stacking.
    const existing = this.pendingByKey.get(key);
    if (existing) return existing.promise;

    const timeoutMs =
      typeof input.timeoutMs === 'number' &&
      Number.isFinite(input.timeoutMs) &&
      input.timeoutMs > 0
        ? Math.min(input.timeoutMs, this.timeoutMs)
        : this.timeoutMs;
    const createdAt = this.now();
    const request: PermissionRequest = {
      id: this.createId(),
      sessionId,
      toolName,
      risk: effectiveRisk,
      argsPreview: input.argsPreview.slice(0, ARGS_PREVIEW_MAX_CHARS),
      reason: input.reason,
      createdAt,
      expiresAt: createdAt + timeoutMs,
    };
    let resolvePromise!: (decision: 'allow-once' | 'allow-session') => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<'allow-once' | 'allow-session'>(
      (resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      },
    );
    const pending: Pending = {
      request,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      timer: setTimeout(() => {
        this.finish(
          pending,
          'timeout',
          new PermissionError(
            'PERMISSION_TIMEOUT',
            'Permission request timed out',
          ),
        );
      }, timeoutMs),
      sessionOnly: input.sessionOnly === true,
      cooldownScope,
    };
    this.pendingByKey.set(key, pending);
    this.pendingById.set(request.id, pending);
    if (this.active) this.queue.push(pending);
    else this.activate(pending);
    return promise;
  }

  /** Responder answer. Unknown decisions are treated as deny (fail-closed). */
  respond(requestId: string, decision: PermissionDecision | string): void {
    const pending = this.pendingById.get(requestId);
    if (!pending || pending.request.expiresAt <= this.now()) {
      throw new PermissionError(
        'INVALID_PERMISSION_REQUEST',
        'Permission request is stale',
      );
    }
    if (decision === 'allow-once' && !pending.sessionOnly) {
      this.finish(pending, 'allowed-once', undefined, 'allow-once');
      return;
    }
    if (decision === 'allow-session') {
      this.options.grantSession(
        pending.request.sessionId,
        pending.request.toolName,
        'user-prompt',
      );
      this.finish(pending, 'allowed-session', undefined, 'allow-session');
      return;
    }
    // "deny", "allow-once" on a session-only request, and every unknown
    // value land here on purpose (fail closed).
    this.deniedUntil.set(
      pendingKey(pending.request.sessionId, pending.cooldownScope),
      this.now() + this.denyCooldownMs,
    );
    this.finish(
      pending,
      'denied',
      new PermissionError('TOOL_DENIED', 'The user denied the tool call'),
    );
  }

  /**
   * Re-resolve a pending request after an external persistent-policy change
   * (e.g. the user edited settings while a prompt was showing). "allow"
   * records a persistent-policy session grant; "deny" fails closed without
   * arming the cooldown.
   */
  applyPolicyChange(requestId: string, outcome: 'allow' | 'deny'): void {
    const pending = this.pendingById.get(requestId);
    if (!pending) return;
    if (outcome === 'allow') {
      this.options.grantSession(
        pending.request.sessionId,
        pending.request.toolName,
        'persistent-policy',
      );
      this.finish(pending, 'persistent-policy', undefined, 'allow-session');
      return;
    }
    this.finish(
      pending,
      'denied',
      new PermissionError(
        'TOOL_DENIED',
        'The call is denied by the persistent policy',
      ),
    );
  }

  /**
   * Cancellation is authoritative: it wins over any racing response. When
   * matchTool is given, only pendings/cooldowns whose tool (or cooldown
   * scope) matches are cancelled.
   */
  cancelSession(
    sessionId: string,
    matchTool?: (toolName: string) => boolean,
  ): void {
    for (const pending of [...this.pendingById.values()]) {
      if (pending.request.sessionId !== sessionId) continue;
      if (
        matchTool &&
        !matchTool(pending.request.toolName) &&
        !matchTool(pending.cooldownScope)
      )
        continue;
      this.finish(
        pending,
        'cancelled',
        new PermissionError(
          'PERMISSION_UNAVAILABLE',
          'The permission request was cancelled',
        ),
      );
    }
    for (const key of [...this.deniedUntil.keys()]) {
      const sep = key.indexOf('\0');
      if (key.slice(0, sep) !== sessionId) continue;
      if (matchTool && !matchTool(key.slice(sep + 1))) continue;
      this.deniedUntil.delete(key);
    }
  }

  cancelAll(matchTool?: (toolName: string) => boolean): void {
    for (const pending of [...this.pendingById.values()]) {
      if (
        matchTool &&
        !matchTool(pending.request.toolName) &&
        !matchTool(pending.cooldownScope)
      )
        continue;
      this.finish(
        pending,
        'cancelled',
        new PermissionError(
          'PERMISSION_UNAVAILABLE',
          'The permission request was cancelled',
        ),
      );
    }
    for (const key of [...this.deniedUntil.keys()]) {
      if (matchTool && !matchTool(toolOfPendingKey(key))) continue;
      this.deniedUntil.delete(key);
    }
  }

  listPending(): PermissionRequest[] {
    return [...this.pendingById.values()].map(({ request }) =>
      structuredClone(request),
    );
  }

  private finish(
    pending: Pending,
    outcome: PermissionResolveOutcome,
    error?: Error,
    decision?: 'allow-once' | 'allow-session',
  ): void {
    if (!this.pendingById.has(pending.request.id)) return;
    clearTimeout(pending.timer);
    this.pendingById.delete(pending.request.id);
    this.pendingByKey.delete(
      pendingKey(pending.request.sessionId, pending.request.toolName),
    );
    const queueIndex = this.queue.indexOf(pending);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    if (this.active === pending) this.active = null;
    const audit: ResolvedAuditFields = {
      decision:
        outcome === 'denied' || outcome === 'timeout' || outcome === 'cancelled'
          ? 'deny'
          : 'allow',
      riskLevel: pending.request.risk,
      toolName: pending.request.toolName,
      sessionId: pending.request.sessionId,
      timestamp: new Date().toISOString(),
      ...(error instanceof PermissionError ? { errorCode: error.code } : {}),
    };
    try {
      this.options.emitResolved(pending.request.id, outcome, audit);
    } catch {
      // Listener isolation: a throwing emitter must not strand the caller
      // (unsettled promise) or stall the serial queue. State cleanup,
      // settlement, and queue advance proceed regardless.
    }
    if (error) pending.reject(error);
    else pending.resolve(decision ?? 'allow-once');
    if (!this.active) {
      const next = this.queue.shift();
      if (next && this.pendingById.has(next.request.id)) this.activate(next);
    }
  }

  private activate(pending: Pending): void {
    this.active = pending;
    try {
      this.options.emitRequest(structuredClone(pending.request));
    } catch {
      // Fail closed: if the request never surfaced, nothing can answer
      // it. Settle with PERMISSION_UNAVAILABLE; finish() clears state and
      // advances the queue (listener isolation applies to emitRequest).
      this.finish(
        pending,
        'denied',
        new PermissionError(
          'PERMISSION_UNAVAILABLE',
          'The permission request could not be surfaced',
        ),
      );
    }
  }
}

export function validateSessionId(value: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > 256 || /[\0\r\n]/.test(normalized)) {
    throw new PermissionError(
      'INVALID_PERMISSION_REQUEST',
      'sessionId is invalid',
    );
  }
  return normalized;
}

export function validateToolName(value: string): string {
  const normalized = normalizeToolName(typeof value === 'string' ? value : '');
  if (!/^[a-z0-9_.-]{1,64}$/.test(normalized)) {
    throw new PermissionError(
      'INVALID_PERMISSION_REQUEST',
      'toolName is invalid',
    );
  }
  return normalized;
}
