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

// ---------------------------------------------------------------------------
// Remote message fetch — load a session's message history from the Web API.
// ---------------------------------------------------------------------------

/** A single UIMessage as returned by GET /api/cli/sessions/[id]/messages. */
export interface RemoteUIMessage {
	id: string;
	role: "user" | "assistant";
	parts: Array<{
		type: string;
		text?: string;
		// tool-call / tool-result / file parts carry extra fields we don't
		// need to type strictly here — we only extract text for display.
		[key: string]: unknown;
	}>;
	metadata?: {
		versions?: Array<{
			parts: Array<{ type: string; text?: string }>;
			createdAt: string;
			response?: Array<{ type: string; text?: string }>;
		}>;
		currentVersionIndex?: number;
		[key: string]: unknown;
	};
}

/** Response envelope from GET /api/cli/sessions/[id]/messages. */
interface RemoteMessagesResponse {
	ok: boolean;
	session?: { id: string; title: string | null; model: string | null };
	messages?: RemoteUIMessage[];
	error?: string;
}

/**
 * Fetch a session's message history from the Web backend.
 * Returns `{ session, messages }` on success; throws on non-ok / network error.
 */
export async function fetchRemoteMessages(
	auth: AgentbosterAuth,
	sessionId: string,
): Promise<{ session: { id: string; title: string | null; model: string | null }; messages: RemoteUIMessage[] }> {
	const res = await fetch(`${root(auth)}/api/cli/sessions/${encodeURIComponent(sessionId)}/messages`, {
		headers: authHeaders(auth),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(`Failed to load session (${res.status}): ${body.error ?? res.statusText}`);
	}
	const data = (await res.json()) as RemoteMessagesResponse;
	if (!data.ok || !data.session || !data.messages) {
		throw new Error(data.error ?? "Malformed response from server.");
	}
	return { session: data.session, messages: data.messages };
}

/**
 * Extract plain text from a UIMessage's parts (current version).
 * Used to rebuild user/assistant text for SessionEntry messages.
 */
export function uiMessageToText(msg: RemoteUIMessage): string {
	// If the message has versions, prefer the current version's parts.
	if (msg.metadata?.versions && msg.metadata.versions.length > 0) {
		const idx = msg.metadata.currentVersionIndex ?? 0;
		const version = msg.metadata.versions[Math.min(idx, msg.metadata.versions.length - 1)];
		return version.parts
			.filter((p) => p.type === "text" && typeof p.text === "string")
			.map((p) => p.text!)
			.join("\n");
	}
	// Otherwise use the message's own parts.
	return msg.parts
		.filter((p) => p.type === "text" && typeof p.text === "string")
		.map((p) => p.text!)
		.join("\n");
}

/**
 * Convenience: fetch messages for the current device's CLI session.
 * Returns null when not logged in (caller should fall back or error).
 */
export async function fetchMyRemoteMessages(
	sessionId: string,
): Promise<{ session: { id: string; title: string | null; model: string | null }; messages: RemoteUIMessage[] } | null> {
	const auth = getStoredAuth();
	if (!auth) return null;
	return fetchRemoteMessages(auth, sessionId);
}
