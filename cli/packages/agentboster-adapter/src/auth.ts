/**
 * Auth storage for the Agentboster adapter.
 *
 * Stores `{ url, token, username }` at `$AGENTBOSTER_HOME/config.json`
 * (default `~/.agentboster`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AgentbosterAuth {
	url: string;
	token: string;
	username?: string;
}

export interface AgentbosterStoredConfig {
	url: string;
	token?: string;
	username?: string;
}

export function getAgentbosterHome(): string {
	return process.env.AGENTBOSTER_HOME ?? join(homedir(), ".agentboster");
}

export function getConfigPath(): string {
	return join(getAgentbosterHome(), "config.json");
}

export function readStoredConfig(): AgentbosterStoredConfig | null {
	const path = getConfigPath();
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as AgentbosterStoredConfig;
	} catch {
		return null;
	}
}

export function writeStoredConfig(config: AgentbosterStoredConfig): void {
	const path = getConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function getStoredAuth(): AgentbosterAuth | null {
	const stored = readStoredConfig();
	if (!stored?.url || !stored?.token) return null;
	return { url: stored.url, token: stored.token, username: stored.username };
}

export function clearStoredAuth(): void {
	const stored = readStoredConfig();
	if (!stored) return;
	writeStoredConfig({ url: stored.url });
}
