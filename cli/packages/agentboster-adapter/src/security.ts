/**
 * L0/L1/L2 security evaluation for local tool requests.
 *
 * L0: rule-based allow/block (rm -rf, mkfs, dd, etc.)
 * L1: LLM-based scoring (optional, requires a local scoring endpoint)
 * L2: user confirmation required
 *
 * Used by handleLocalToolRequest in main.ts to gate local_exec /
 * local_write_file before executing on the CLI host.
 */

export type SecurityLevel = "l0" | "l1" | "l2";

export interface SecurityDecision {
	ok: boolean;
	level: SecurityLevel;
	message: string;
	/** True when the command is safe to auto-approve (L0+L1 passed). */
	autoApprove: boolean;
}

const L0_BLOCK_PATTERNS: RegExp[] = [
	/\brm\s+(-[rfRF]+\s+)+\//,
	/\bmkfs\b/,
	/\bdd\s+/,
	/\/etc\/shadow/,
	/\bchmod\s+(777|666|a\+rwx)/,
];

const L0_ESCALATE_PATTERNS: RegExp[] = [
	/\bgit\s+(reset\s+--hard|checkout\s+--|clean\s+-[fd]+)/,
	/\b(curl|wget|nc|nmap|telnet)\s/,
	/\b(npm\s+install|pip\s+install|apt\s+install|yum\s+install|brew\s+install)/,
];

/**
 * Evaluate a command string (or tool input) against L0 rules.
 * Does NOT call the L1 scoring endpoint — that's optional and
 * requires AGENTBOSTER_SCORER_URL.
 */
export function evaluateLocalCommand(command: string): SecurityDecision {
	for (const pattern of L0_BLOCK_PATTERNS) {
		if (pattern.test(command)) {
			return {
				ok: false,
				level: "l0",
				message: `Blocked by L0 rule: ${pattern.source}`,
				autoApprove: false,
			};
		}
	}

	for (const pattern of L0_ESCALATE_PATTERNS) {
		if (pattern.test(command)) {
			return {
				ok: true,
				level: "l2",
				message: `L2 confirmation required (matched ${pattern.source})`,
				autoApprove: false,
			};
		}
	}

	return {
		ok: true,
		level: "l1",
		message: "Passed L0/L1 checks",
		autoApprove: true,
	};
}

/**
 * Build a display string for a tool request (used in confirmation prompts).
 */
export function formatToolRequest(toolName: string, toolInput: unknown): string {
	const input = toolInput as Record<string, unknown> | undefined;
	switch (toolName) {
		case "local_exec":
			return `$ ${String(input?.command ?? "")}`;
		case "local_write_file":
			return `write ${String(input?.path ?? "")} (${String(input?.content ?? "").length} bytes)`;
		case "local_read_file":
			return `read ${String(input?.path ?? "")}`;
		default:
			return `${toolName} ${JSON.stringify(toolInput ?? {})}`;
	}
}
