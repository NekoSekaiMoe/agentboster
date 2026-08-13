/**
 * Phase-1 deterministic skill security scanner. Port of deer-flow's
 * skillscan orchestrator (ref/backend/.../skills/skillscan/orchestrator.py),
 * scoped to agentboster's needs:
 *
 *   - Secret patterns (private keys, cloud tokens, env assignments)
 *   - Shell exec / reverse shells / destructive commands (bash + sh)
 *   - Dynamic eval/exec (python + node)
 *   - Sensitive-path reads + network-sink co-occurrence (exfil heuristic)
 *   - Path traversal in archive member names
 *   - Executable binary magic (ELF / PE / Mach-O)
 *
 * Skipped from deer-flow's full set (intentionally, Phase-1 scope):
 *   - The AST-based python client-handle evidence chain (orchestrator.py
 *     _find_client_handle_sink, ~560 lines of scope-walking state machine).
 *     Too expensive to port verbatim; the regex secret/shell/exec rules
 *     catch the overwhelming majority of real exfil payloads. A future
 *     Phase-2 LLM pass (behind experiments.skillScan.llmModeration) will
 *     cover the residual.
 *
 * CRITICAL findings raise SkillSecurityScanError. HIGH/MEDIUM/LOW are
 * returned as warnings (caller may log or surface). The split mirrors
 * deer-flow: only CRITICAL blocks; everything else is advisory.
 *
 * Workflow-bundle safety: this module is reachable from the workflow body
 * via lib/workflow/agent/tools/skills/local.ts → lib/core/blob/skills.ts.
 * It therefore MUST NOT use top-level node:* imports — everything is pure
 * regex over Uint8Array/string, no fs/path/crypto. See AGENTS.md "Top-level
 * node:* imports break the workflow bundle".
 */

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface SecurityFinding {
  ruleId: string;
  severity: Severity;
  message: string;
  /** Remediation hint shown alongside the finding. */
  remediation: string;
  /** File path within the skill (relative). Null for package-level. */
  path: string | null;
  /** Redacted evidence snippet (never contains secret bytes). */
  evidence: string;
}

/**
 * Raised when a Phase-1 scan produced ≥1 CRITICAL finding. Carries the full
 * finding list so the caller can surface all blockers at once rather than
 * fail-fast on the first.
 */
export class SkillSecurityScanError extends Error {
  readonly findings: SecurityFinding[];
  constructor(findings: SecurityFinding[]) {
    const critical = findings.filter((f) => f.severity === 'CRITICAL');
    super(
      `skill security scan blocked: ${critical.length} critical finding(s):\n` +
        critical
          .map((f) => `  [${f.ruleId}] ${f.path ?? '<package>'}: ${f.message}`)
          .join('\n'),
    );
    this.name = 'SkillSecurityScanError';
    this.findings = findings;
  }
}

// ─── Rule specs ───────────────────────────────────────────────────────

interface RuleSpec {
  ruleId: string;
  severity: Severity;
  message: string;
  remediation: string;
}

const RULES = {
  SECRET_PRIVATE_KEY: {
    ruleId: 'secret-private-key',
    severity: 'CRITICAL',
    message: 'Private key material detected.',
    remediation: 'Remove the private key file; load secrets from the vault.',
  } satisfies RuleSpec,
  SECRET_CLOUD_TOKEN: {
    ruleId: 'secret-cloud-token',
    severity: 'CRITICAL',
    message: 'Hardcoded cloud/API token detected.',
    remediation: 'Rotate the leaked token and move it to the vault.',
  } satisfies RuleSpec,
  SHELL_REVERSE: {
    ruleId: 'shell-reverse-shell',
    severity: 'CRITICAL',
    message: 'Reverse shell pattern detected.',
    remediation: 'Remove the reverse shell payload.',
  } satisfies RuleSpec,
  SHELL_DESTRUCTIVE: {
    ruleId: 'shell-destructive',
    severity: 'CRITICAL',
    message:
      'Destructive command detected (recursive rm of system paths, fork bomb, or dd to device).',
    remediation: 'Remove the destructive command.',
  } satisfies RuleSpec,
  SHELL_CURL_PIPE: {
    ruleId: 'shell-curl-pipe-shell',
    severity: 'HIGH',
    message: 'curl|wget piped to sh|bash — common payload vector.',
    remediation: 'Download to a file, verify, then execute.',
  } satisfies RuleSpec,
  PY_DYNAMIC_EXEC: {
    ruleId: 'python-dynamic-exec',
    severity: 'CRITICAL',
    message: 'Dynamic code execution (eval/exec/compile) detected.',
    remediation: 'Avoid eval/exec; use a parser or literal code.',
  } satisfies RuleSpec,
  PY_SHELL_EXEC: {
    ruleId: 'python-shell-exec',
    severity: 'CRITICAL',
    message:
      'Shell execution (os.system/os.popen/subprocess with shell) detected.',
    remediation: 'Use subprocess with shell=False and a literal argv list.',
  } satisfies RuleSpec,
  NETWORK_CLOUD_METADATA: {
    ruleId: 'network-cloud-metadata',
    severity: 'CRITICAL',
    message:
      'Cloud metadata endpoint (169.254.169.254 / metadata.google.internal) referenced.',
    remediation:
      'Remove the metadata-endpoint reference; skills must not scrape instance credentials.',
  } satisfies RuleSpec,
  PACKAGE_PATH_TRAVERSAL: {
    ruleId: 'package-path-traversal',
    severity: 'CRITICAL',
    message: 'Archive member path contains ".." — path traversal.',
    remediation:
      'Reject the archive; it is attempting to escape its directory.',
  } satisfies RuleSpec,
  PACKAGE_EXECUTABLE_BINARY: {
    ruleId: 'package-executable-binary',
    severity: 'CRITICAL',
    message: 'Executable binary (ELF/PE/Mach-O) detected.',
    remediation:
      'Remove the binary; skills ship source, not compiled artifacts.',
  } satisfies RuleSpec,
  EXFIL_SENSITIVE_PATH: {
    ruleId: 'exfil-sensitive-path-and-network-sink',
    severity: 'CRITICAL',
    message:
      'Sensitive path read and network sink co-occur — likely exfiltration.',
    remediation:
      'Do not read sensitive host paths and egress in the same skill.',
  } satisfies RuleSpec,
} as const;

// ─── Pattern banks ────────────────────────────────────────────────────

const PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z0-9 ]+)?PRIVATE KEY-----/;

// Cloud tokens: AWS access key, GitHub PAT, Slack token, OpenAI-style sk-.
// Placeholder guard: values like "AKIAXXXXXXXXXXXXXXXX", "your-key-here",
// "xxxx", "<token>" are not flagged.
const CLOUD_TOKEN_RES = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
];
const PLACEHOLDER_RE =
  /^(?:x+|<{1,2}[a-z -]*>{1,2}|your[-_ ]?(?:key|token|secret)|example|placeholder|changeme|todo|redacted)$/i;

const SHELL_REVERSE_RES = [
  /\/dev\/tcp\//,
  /\bnc\b[^;\n]*\s+-e\s+(?:\/bin\/(?:sh|bash)|sh|bash)/,
  /\bbash\s+-i\b[^;\n]*>\s*&\s*1/,
];
const DESTRUCTIVE_RM_RE =
  /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*\s+)?(?:--no-preserve-root\s+)?(?:\/(?:\s|$|\*)|(?:bin|boot|etc|lib|proc|root|run|sbin|sys|usr|var|home)(?:\/|\s|$)|\*+)/;
const FORKBOMB_RE = /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/;
const DD_TO_DEVICE_RE = /\bdd\b[^;\n]*\bof=\/dev\/(?:sd|nvme|hd|vd)/;
const CURL_PIPE_SHELL_RE = /(?:curl|wget)[^|\n]*\|\s*(?:\/bin\/)?(?:sh|bash)\b/;

const PY_EVAL_EXEC_RE = /\b(?:eval|exec|compile)\s*\(/;
const PY_SHELL_EXEC_RES = [
  /\bos\.system\s*\(/,
  /\bos\.popen\s*\(/,
  /\bsubprocess\.(?:call|run|Popen|check_call|check_output)\s*\([^)]*shell\s*=\s*True/,
];

const CLOUD_METADATA_RE = /(?:169\.254\.169\.254|metadata\.google\.internal)/;

const EXECUTABLE_MAGICS: ReadonlyArray<{ magic: number[]; label: string }> = [
  { magic: [0x7f, 0x45, 0x4c, 0x46], label: 'ELF' }, // \x7fELF
  { magic: [0x4d, 0x5a], label: 'PE' }, // MZ
  { magic: [0xcf, 0xfa, 0xed, 0xfe], label: 'Mach-O' }, // 64-bit LE
  { magic: [0xce, 0xfa, 0xed, 0xfe], label: 'Mach-O' }, // 32-bit LE
  { magic: [0xfe, 0xed, 0xfa, 0xce], label: 'Mach-O' },
  { magic: [0xfe, 0xed, 0xfa, 0xcf], label: 'Mach-O' },
];

// Sensitive paths (deer-flow _SENSITIVE_PATH_RE, pruned to the high-value set).
const SENSITIVE_PATH_RE =
  /(?:~\/\.ssh|\/etc\/(?:passwd|shadow)|\/var\/run\/docker\.sock|\/\.aws\/credentials)/;
// Network sinks in shell or as outbound URLs (loopback/RFC1918 excluded for the URL form).
const NETWORK_SINK_RE =
  /\b(?:curl|wget|nc|scp|ftp|ssh)\b|(?:https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.))/i;

// ─── Helpers ──────────────────────────────────────────────────────────

function redactSecret(raw: string): string {
  // Redact to the first 4 + last 2 chars, cap evidence at 60 chars total.
  // Never emit the full token.
  const trimmed = raw.trim();
  if (trimmed.length <= 8) return '[redacted]';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-2)}`;
}

function truncate(s: string, max = 80): string {
  const single = s.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

/** Safe first-match extractor: returns the matched substring or '' if the
 *  regex didn't match (callers gate on .test() first, but this keeps TS and
 *  the lint no-non-null rule happy without an assertion). */
function firstMatch(re: RegExp, text: string): string {
  return text.match(re)?.[0] ?? '';
}

function looksLikePlaceholder(token: string): boolean {
  // Strip common token prefixes (sk-, xox[baprs]-, gh[pousr]_, AKIA/ASIA)
  // so the placeholder check sees the variable part. deer-flow's guard
  // matches on the full match; we mirror it but peel known prefixes so
  // "sk-xxxxxxxxxxxxxxxxxxxx" is recognized as a placeholder.
  const stripped = token
    .replace(/^(?:sk-|xox[baprs]-|gh[pousr]_|AKIA|ASIA)/, '')
    .trim();
  return PLACEHOLDER_RE.test(stripped);
}

/** Detect executable-binary magic bytes in the first 8 bytes of a file. */
function detectExecutableMagic(bytes: Uint8Array): string | null {
  if (bytes.length < 2) return null;
  for (const { magic, label } of EXECUTABLE_MAGICS) {
    if (magic.every((b, i) => bytes[i] === b)) return label;
  }
  return null;
}

// ─── Per-file scan ────────────────────────────────────────────────────

/**
 * Scan a single file's content. Returns findings (empty list = clean).
 * `relativePath` is the skill-relative path (used for the finding's `path`
 * and to detect shell/python files by extension/shebang).
 *
 * Content is a Uint8Array so we can both (a) check executable magic on the
 * raw bytes and (b) decode to text for the regex rules. Files with NUL
 * bytes in the first 4KB are treated as binary and only the magic check
 * runs (deer-flow's _decode_text_for_analysis behavior).
 */
export function scanSkillFileContent(
  relativePath: string,
  content: Uint8Array,
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  // Binary magic check first — works on raw bytes regardless of decodability.
  const binaryKind = detectExecutableMagic(content);
  if (binaryKind) {
    findings.push({
      ...RULES.PACKAGE_EXECUTABLE_BINARY,
      path: relativePath,
      evidence: `${binaryKind} magic bytes`,
    });
    return findings; // don't try to text-scan a binary
  }

  // Reject files with NUL in the first 4KB as binary (non-text). deer-flow
  // uses the same heuristic to avoid scanning compiled blobs mislabeled .txt.
  const sniffLen = Math.min(content.length, 4096);
  let isText = true;
  for (let i = 0; i < sniffLen; i++) {
    if (content[i] === 0) {
      isText = false;
      break;
    }
  }
  if (!isText) return findings;

  const text = new TextDecoder('utf-8', { fatal: false }).decode(content);

  const lower = relativePath.toLowerCase();
  const isShell =
    lower.endsWith('.sh') ||
    /(^|\n)\s*#!\s*(?:\/[^\n]*\b(?:bash|sh|zsh)\b)/.test(text);
  const isPython =
    lower.endsWith('.py') ||
    /(^|\n)\s*#!\s*(?:\/[^\n]*\bpython[0-9]?\b)/.test(text);

  // ── Secrets (all text files) ───────────────────────────────────────
  if (PRIVATE_KEY_RE.test(text)) {
    findings.push({
      ...RULES.SECRET_PRIVATE_KEY,
      path: relativePath,
      evidence: '-----BEGIN … PRIVATE KEY-----',
    });
  }
  for (const re of CLOUD_TOKEN_RES) {
    const match = text.match(re);
    if (match && !looksLikePlaceholder(match[0])) {
      findings.push({
        ...RULES.SECRET_CLOUD_TOKEN,
        path: relativePath,
        evidence: redactSecret(match[0]),
      });
      break; // one per file is enough to flag
    }
  }

  // ── Cloud metadata (all text files) ────────────────────────────────
  if (CLOUD_METADATA_RE.test(text)) {
    findings.push({
      ...RULES.NETWORK_CLOUD_METADATA,
      path: relativePath,
      evidence: truncate(firstMatch(CLOUD_METADATA_RE, text)),
    });
  }

  // ── Shell rules ────────────────────────────────────────────────────
  if (isShell) {
    for (const re of SHELL_REVERSE_RES) {
      const m = text.match(re);
      if (m) {
        findings.push({
          ...RULES.SHELL_REVERSE,
          path: relativePath,
          evidence: truncate(m[0]),
        });
        break;
      }
    }
    if (
      DESTRUCTIVE_RM_RE.test(text) ||
      FORKBOMB_RE.test(text) ||
      DD_TO_DEVICE_RE.test(text)
    ) {
      const m =
        text.match(DESTRUCTIVE_RM_RE) ??
        text.match(FORKBOMB_RE) ??
        text.match(DD_TO_DEVICE_RE);
      findings.push({
        ...RULES.SHELL_DESTRUCTIVE,
        path: relativePath,
        evidence: truncate(m?.[0] ?? ''),
      });
    }
    if (CURL_PIPE_SHELL_RE.test(text)) {
      findings.push({
        ...RULES.SHELL_CURL_PIPE,
        path: relativePath,
        evidence: truncate(firstMatch(CURL_PIPE_SHELL_RE, text)),
      });
    }
    // Shell exfil: sensitive path + network sink co-occurring.
    if (SENSITIVE_PATH_RE.test(text) && NETWORK_SINK_RE.test(text)) {
      findings.push({
        ...RULES.EXFIL_SENSITIVE_PATH,
        path: relativePath,
        evidence: 'sensitive path + network sink in same script',
      });
    }
  }

  // ── Python rules ───────────────────────────────────────────────────
  if (isPython) {
    if (PY_EVAL_EXEC_RE.test(text)) {
      findings.push({
        ...RULES.PY_DYNAMIC_EXEC,
        path: relativePath,
        evidence: truncate(firstMatch(PY_EVAL_EXEC_RE, text)),
      });
    }
    for (const re of PY_SHELL_EXEC_RES) {
      const m = text.match(re);
      if (m) {
        findings.push({
          ...RULES.PY_SHELL_EXEC,
          path: relativePath,
          evidence: truncate(m[0]),
        });
        break;
      }
    }
    // Python exfil: same heuristic as shell.
    if (SENSITIVE_PATH_RE.test(text) && NETWORK_SINK_RE.test(text)) {
      findings.push({
        ...RULES.EXFIL_SENSITIVE_PATH,
        path: relativePath,
        evidence: 'sensitive path + network sink in same script',
      });
    }
  }

  return findings;
}

// ─── Package-level (path traversal in member names) ───────────────────

/** Scan a list of skill-relative file paths for traversal/absolute escapes. */
export function scanSkillPaths(
  relativePaths: ReadonlyArray<string>,
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const p of relativePaths) {
    if (p.includes('..') || p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) {
      findings.push({
        ...RULES.PACKAGE_PATH_TRAVERSAL,
        path: p,
        evidence: p,
      });
    }
  }
  return findings;
}

// ─── Top-level scan + enforce ─────────────────────────────────────────

export interface SkillFileInput {
  /** Skill-relative path. */
  path: string;
  /** Raw file content (bytes). */
  content: Uint8Array;
}

/**
 * Scan a complete skill (all files + path list). Returns ALL findings
 * (CRITICAL + advisory). Does not raise — caller decides what to do with
 * the list (the blob chokepoints call {@link enforceScan} which raises on
 * CRITICAL).
 */
export function scanSkill(
  files: ReadonlyArray<SkillFileInput>,
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  findings.push(...scanSkillPaths(files.map((f) => f.path)));
  for (const file of files) {
    findings.push(...scanSkillFileContent(file.path, file.content));
  }
  return findings;
}

/**
 * Run {@link scanSkill} and raise {@link SkillSecurityScanError} if any
 * CRITICAL finding is present. Returns the full finding list otherwise
 * (advisory HIGH/MEDIUM/LOW included, for the caller to log). This is the
 * deer-flow `enforce_static_scan` analogue and what the blob chokepoints
 * call before put().
 */
export function enforceScan(
  files: ReadonlyArray<SkillFileInput>,
): SecurityFinding[] {
  const findings = scanSkill(files);
  if (findings.some((f) => f.severity === 'CRITICAL')) {
    throw new SkillSecurityScanError(findings);
  }
  return findings;
}
