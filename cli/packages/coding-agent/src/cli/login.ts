/**
 * `agentboster login` — top-level subcommand.
 *
 * Replaces pi's auth flow (Google OAuth / API key / Vertex) with
 * Agentboster server credentials: url + (username+password OR pair code).
 *
 * Result is written to ~/.agentboster/config.json by way of
 * @agentboster/adapter's writeStoredConfig.
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
	type AgentbosterStoredConfig,
	writeStoredConfig,
} from "@agentboster/adapter";

const DEFAULT_CLIENT_LABEL = "agentboster-cli";

export interface LoginOptions {
	/** Server URL (e.g. https://claw.example.com). Required. */
	url?: string;
	/** Username for password login. */
	username?: string;
	/** Password for password login. */
	password?: string;
	/** Pair code (one-shot, issued by the web UI). */
	pairCode?: string;
	/** Human-readable label for this CLI install (hostname, OS). */
	label?: string;
}

/**
 * Dispatch `agentboster login [...]` from argv.
 *
 * Returns true if the first arg was `login` (handled, caller should exit).
 * Returns false otherwise (caller should keep dispatching).
 */
export async function handleLoginCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "login") return false;

	const opts = parseLoginArgs(args.slice(1));
	await runLogin(opts);
	process.exit(0);
}

function parseLoginArgs(args: string[]): LoginOptions {
	const opts: LoginOptions = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) continue;
		if (arg === "-u" || arg === "--url") {
			opts.url = args[++i];
		} else if (arg === "--username") {
			opts.username = args[++i];
		} else if (arg === "--password") {
			opts.password = args[++i];
		} else if (arg === "--pair-code" || arg === "--code") {
			opts.pairCode = args[++i];
		} else if (arg === "--label") {
			opts.label = args[++i];
		} else if (arg === "-h" || arg === "--help") {
			printLoginHelp();
			process.exit(0);
		} else {
			output.write(`Unknown login flag: ${arg}\n`);
			printLoginHelp();
			process.exit(1);
		}
	}
	return opts;
}

function printLoginHelp(): void {
	output.write(
		[
			"agentboster login — authenticate with the Agentboster server",
			"",
			"Usage:",
			"  agentboster login                                 # interactive",
			"  agentboster login -u <url> --username <u> --password <p>",
			"  agentboster login -u <url> --pair-code <code>",
			"",
			"Options:",
			"  -u, --url <url>         Server URL (e.g. https://claw.example.com)",
			"      --username <name>   Username for password login",
			"      --password <pw>     Password for password login",
			"      --pair-code <code>  One-shot pair code issued by the web UI",
			"      --label <text>      Human-readable label for this machine",
			"  -h, --help              Show this help",
			"",
		].join("\n"),
	);
}

export async function runLogin(opts: LoginOptions): Promise<void> {
	const rl = createInterface({ input, output });
	try {
		const url = (opts.url ?? (await rl.question("Server URL: "))).trim();
		if (!url) throw new Error("Server URL is required.");

		const label = opts.label ?? DEFAULT_CLIENT_LABEL;

		let token: string;
		let username: string | undefined;

		if (opts.pairCode) {
			const result = await exchangePairCode(url, opts.pairCode, label);
			token = result.token;
			username = result.username;
		} else if (opts.username && opts.password) {
			const result = await loginWithPassword(url, opts.username, opts.password);
			token = result.token;
			username = result.username;
		} else {
			// Interactive: pick method.
			output.write("\nChoose login method:\n  1. Username + password\n  2. Pair code\n");
			const choice = (await rl.question("Method [1/2]: ")).trim();
			if (choice === "2") {
				const code = (await rl.question("Pair code: ")).trim();
				const result = await exchangePairCode(url, code, label);
				token = result.token;
				username = result.username;
			} else {
				const usernameIn = (await rl.question("Username: ")).trim();
				if (!usernameIn) throw new Error("Username is required.");
				const password = (await rl.question("Password: ")).trim();
				if (!password) throw new Error("Password is required.");
				const result = await loginWithPassword(url, usernameIn, password);
				token = result.token;
				username = result.username;
			}
		}

		const config: AgentbosterStoredConfig = { url, token, username };
		writeStoredConfig(config);
		output.write(`Logged in${username ? ` as ${username}` : ""}.\n`);
	} finally {
		rl.close();
	}
}

interface LoginResult {
	token: string;
	username?: string;
}

async function loginWithPassword(
	url: string,
	username: string,
	password: string,
): Promise<LoginResult> {
	const response = await fetch(`${url.replace(/\/$/, "")}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ username, password }),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Login failed (HTTP ${response.status}): ${text || response.statusText}`);
	}
	const payload = (await response.json()) as {
		ok: boolean;
		token?: string;
		error?: string;
		user?: { id: string; username: string };
	};
	if (!payload.ok || !payload.token) {
		throw new Error(payload.error ?? "Login failed");
	}
	return { token: payload.token, username: payload.user?.username };
}

async function exchangePairCode(
	url: string,
	pairCode: string,
	label: string,
): Promise<LoginResult> {
	const response = await fetch(`${url.replace(/\/$/, "")}/api/auth/pair-exchange`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ pairCode, label }),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Pair code exchange failed (HTTP ${response.status}): ${text || response.statusText}`);
	}
	const payload = (await response.json()) as {
		ok: boolean;
		token?: string;
		error?: string;
		username?: string;
	};
	if (!payload.ok || !payload.token) {
		throw new Error(payload.error ?? "Pair code exchange failed");
	}
	return { token: payload.token, username: payload.username };
}
