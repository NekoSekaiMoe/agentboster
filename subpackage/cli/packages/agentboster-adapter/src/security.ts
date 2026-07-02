/**
 * L0/L1/L2 security evaluation for local tool requests.
 *
 * L0: rule-based allow/block. Rules are pulled from the Web backend
 *   (GET /api/cli/l0-rules) so the CLI honors exactly what the user
 *   configured in the settings UI, not a hard-coded list. Cached
 *   in-process with a background refresh.
 * L1: LLM-based scoring via the Web backend (POST /api/cli/l1-score).
 *   Called only when L0 does not already block. Optional — degrades
 *   to L2-confirm on network failure rather than blocking the CLI.
 * L2: user confirmation required (handled by the caller via TTY).
 *
 * Used by handleLocalToolRequest in main.ts to gate local_exec /
 * local_write_file before executing on the CLI host.
 */

export type SecurityLevel = 'l0' | 'l1' | 'l2';

export interface SecurityDecision {
  ok: boolean;
  level: SecurityLevel;
  message: string;
  /** True when the command is safe to auto-approve (L0+L1 passed). */
  autoApprove: boolean;
}

export interface CliAuth {
  url: string;
  token: string;
}

// ── L0 rule cache ───────────────────────────────────────────────────

interface L0Rule {
  pattern: string;
  action: 'block' | 'warn';
}

let cachedRules: L0Rule[] | null = null;
let cacheRefreshAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Hard-coded fallback used when the Web backend is unreachable at
 * session start. Matches the historical block list so behavior never
 * regresses below the pre-Web-sync baseline.
 */
const FALLBACK_BLOCK: RegExp[] = [
  /\brm\s+(-[rfRF]+\s+)+\//,
  /\bmkfs\b/,
  /\bdd\s+/,
  /\/etc\/shadow/,
  /\bchmod\s+(777|666|a\+rwx)/,
];

const FALLBACK_ESCALATE: RegExp[] = [
  /\bgit\s+(reset\s+--hard|checkout\s+--|clean\s+-[fd]+)/,
  /\b(curl|wget|nc|nmap|telnet)\s/,
  /\b(npm\s+install|pip\s+install|apt\s+install|yum\s+install|brew\s+install)/,
];

async function fetchL0Rules(auth: CliAuth): Promise<L0Rule[]> {
  const root = auth.url.replace(/\/$/, '');
  try {
    const response = await fetch(`${root}/api/cli/l0-rules`, {
      headers: {
        authorization: `Bearer ${auth.token}`,
        cookie: `clawless-auth=${auth.token}`,
      },
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { rules?: L0Rule[] };
    return body.rules ?? [];
  } catch {
    return [];
  }
}

/**
 * Return the current L0 rule set, refreshing from Web if stale.
 * Falls back to the hard-coded list if no rules have ever loaded
 * (e.g. offline at startup). Best-effort — never throws.
 */
async function getL0Rules(auth: CliAuth): Promise<{
  block: RegExp[];
  escalate: RegExp[];
  source: 'web' | 'fallback';
}> {
  const now = Date.now();
  if (cachedRules === null || now > cacheRefreshAt) {
    const fresh = await fetchL0Rules(auth);
    if (fresh.length > 0 || cachedRules === null) {
      cachedRules = fresh;
      cacheRefreshAt = now + CACHE_TTL_MS;
    }
  }

  if (cachedRules && cachedRules.length > 0) {
    // Compile patterns; skip invalid ones silently.
    const block: RegExp[] = [];
    for (const r of cachedRules) {
      if (r.action !== 'block') continue;
      try {
        block.push(new RegExp(r.pattern));
      } catch {
        // Invalid user-defined pattern — skip it.
      }
    }
    return { block, escalate: FALLBACK_ESCALATE, source: 'web' };
  }

  return {
    block: FALLBACK_BLOCK,
    escalate: FALLBACK_ESCALATE,
    source: 'fallback',
  };
}

// ── L1 scoring ──────────────────────────────────────────────────────

interface L1ScoreResult {
  score: number;
  level: 'low' | 'medium' | 'high' | 'critical';
  reason: string;
}

async function scoreViaWeb(
  auth: CliAuth,
  command: string,
): Promise<L1ScoreResult | null> {
  const root = auth.url.replace(/\/$/, '');
  try {
    const response = await fetch(`${root}/api/cli/l1-score`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${auth.token}`,
        cookie: `clawless-auth=${auth.token}`,
      },
      body: JSON.stringify({ command }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      ok: boolean;
      result?: L1ScoreResult;
    };
    return body.ok && body.result ? body.result : null;
  } catch {
    return null;
  }
}

// ── Combined evaluation ─────────────────────────────────────────────

/**
 * Evaluate a command against L0 (Web-synced rules) then L1 (Web LLM
 * scoring). The caller drives L2 confirmation based on the returned
 * `autoApprove` flag.
 *
 * Decision table:
 *   L0 block           → ok=false, blocked immediately
 *   L0 escalate match  → L1 scoring decides (fallback to L2-confirm)
 *   L0 clean           → L1 scoring decides (fallback to autoApprove)
 *
 * L1 levels:
 *   low / medium → autoApprove (medium surfaces a non-blocking note)
 *   high         → L2 confirm (autoApprove=false)
 *   critical     → ok=false (blocked, same as L0 block)
 *
 * L1 network/scoring failure is fail-open for clean L0 commands
 * (autoApprove) and fail-closed for L0-escalate commands (require L2
 * confirm). This avoids a Web outage turning the CLI into either an
 * open door or a brick wall.
 */
export async function evaluateLocalCommand(
  command: string,
  auth?: CliAuth,
): Promise<SecurityDecision> {
  // No auth → use fallback hard-coded L0 only, skip L1 entirely.
  // Keeps the function callable from contexts without Web access.
  if (!auth) {
    return evaluateFallback(command);
  }

  const { block, escalate } = await getL0Rules(auth);

  for (const pattern of block) {
    if (pattern.test(command)) {
      return {
        ok: false,
        level: 'l0',
        message: `Blocked by L0 rule: ${pattern.source}`,
        autoApprove: false,
      };
    }
  }

  const escalated = escalate.some((p) => p.test(command));

  // L1 scoring. Failure is tolerated with different defaults depending
  // on whether L0 flagged the command as risky.
  const l1 = await scoreViaWeb(auth, command);
  if (l1) {
    if (l1.level === 'critical') {
      return {
        ok: false,
        level: 'l1',
        message: `Blocked by L1 (critical): ${l1.reason}`,
        autoApprove: false,
      };
    }
    if (l1.level === 'high') {
      return {
        ok: true,
        level: 'l2',
        message: `L2 confirmation required (L1 high: ${l1.reason})`,
        autoApprove: false,
      };
    }
    // low / medium → auto-approve. medium carries a non-blocking note.
    return {
      ok: true,
      level: 'l1',
      message:
        l1.level === 'medium'
          ? `L1 medium risk: ${l1.reason}`
          : 'Passed L0/L1 checks',
      autoApprove: true,
    };
  }

  // L1 unavailable — fall back based on L0 escalation signal.
  if (escalated) {
    return {
      ok: true,
      level: 'l2',
      message: 'L2 confirmation required (L1 unavailable, L0 escalated)',
      autoApprove: false,
    };
  }
  return {
    ok: true,
    level: 'l1',
    message: 'Passed L0 (L1 unavailable, fail-open for clean command)',
    autoApprove: true,
  };
}

/**
 * Pure local fallback used when no auth is supplied. Identical to the
 * pre-Web-sync behavior so callers that don't pass auth get the same
 * decisions they always did.
 */
function evaluateFallback(command: string): SecurityDecision {
  for (const pattern of FALLBACK_BLOCK) {
    if (pattern.test(command)) {
      return {
        ok: false,
        level: 'l0',
        message: `Blocked by L0 rule: ${pattern.source}`,
        autoApprove: false,
      };
    }
  }
  for (const pattern of FALLBACK_ESCALATE) {
    if (pattern.test(command)) {
      return {
        ok: true,
        level: 'l2',
        message: `L2 confirmation required (matched ${pattern.source})`,
        autoApprove: false,
      };
    }
  }
  return {
    ok: true,
    level: 'l1',
    message: 'Passed L0/L1 checks',
    autoApprove: true,
  };
}

/**
 * Build a display string for a tool request (used in confirmation prompts).
 */
export function formatToolRequest(
  toolName: string,
  toolInput: unknown,
): string {
  const input = toolInput as Record<string, unknown> | undefined;
  switch (toolName) {
    case 'local_exec':
      return `$ ${String(input?.command ?? '')}`;
    case 'local_write_file':
      return `write ${String(input?.path ?? '')} (${String(input?.content ?? '').length} bytes)`;
    case 'local_read_file':
      return `read ${String(input?.path ?? '')}`;
    default:
      return `${toolName} ${JSON.stringify(toolInput ?? {})}`;
  }
}
