/**
 * Remote session API client for the Agentboster web backend.
 *
 * Used by the CLI to mirror the web-side session list/title/delete
 * operations, so that sessions deleted on the web disappear from the
 * CLI's --resume / /resume picker too. The local jsonl files in
 * ~/.agentboster/agent/sessions/ remain the source of truth for tree
 * state (branch / rewind / labels) and the LLM context window; this
 * module only covers the CRUD metadata that the web DB owns.
 */

import { getStoredAuth, type AgentbosterAuth } from "@agentboster/adapter";

export interface RemoteSession {
	id: string;
	title: string | null;
	channel: string;
	model: string | null;
	totalTokens: number | null;
	createdAt: string;
	updatedAt: string;
}

function authHeaders(auth: AgentbosterAuth): Record<string, string> {
	return {
		authorization: `Bearer ${auth.token}`,
		cookie: `clawless-auth=${auth.token}`,
	};
}

function root(auth: AgentbosterAuth): string {
	return auth.url.replace(/\/$/, "");
}

export async function listRemoteSessions(
	auth: AgentbosterAuth,
	options: { channel?: string; limit?: number } = {},
): Promise<RemoteSession[]> {
	const params = new URLSearchParams();
	if (options.channel) params.set("channel", options.channel);
	if (options.limit) params.set("limit", String(options.limit));
	const qs = params.toString();
	const res = await fetch(`${root(auth)}/api/cli/sessions${qs ? `?${qs}` : ""}`, {
		headers: authHeaders(auth),
	});
	if (!res.ok) return [];
	const data = (await res.json()) as { sessions?: RemoteSession[] };
	return data.sessions ?? [];
}

export async function getRemoteSession(
	auth: AgentbosterAuth,
	sessionId: string,
): Promise<RemoteSession | null> {
	const res = await fetch(`${root(auth)}/api/cli/sessions/${encodeURIComponent(sessionId)}`, {
		headers: authHeaders(auth),
	});
	if (!res.ok) return null;
	const data = (await res.json()) as { session?: RemoteSession };
	return data.session ?? null;
}

export interface RemoteSessionPatch {
	title?: string | null;
	model?: string | null;
}

export async function patchRemoteSession(
	auth: AgentbosterAuth,
	sessionId: string,
	patch: RemoteSessionPatch,
): Promise<boolean> {
	const res = await fetch(`${root(auth)}/api/cli/sessions/${encodeURIComponent(sessionId)}`, {
		method: "PATCH",
		headers: { "content-type": "application/json", ...authHeaders(auth) },
		body: JSON.stringify(patch),
	});
	return res.ok;
}

export async function deleteRemoteSession(
	auth: AgentbosterAuth,
	sessionId: string,
): Promise<boolean> {
	const res = await fetch(`${root(auth)}/api/cli/sessions/${encodeURIComponent(sessionId)}`, {
		method: "DELETE",
		headers: authHeaders(auth),
	});
	return res.ok;
}

/**
 * Convenience: list sessions for the current device's CLI channel.
 * Returns [] when not logged in.
 */
export async function listMyRemoteSessions(): Promise<RemoteSession[]> {
	const auth = getStoredAuth();
	if (!auth) return [];
	return listRemoteSessions(auth);
}
