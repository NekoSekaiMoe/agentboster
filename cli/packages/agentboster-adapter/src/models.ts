/**
 * Fetch the model catalog from the Agentboster web backend.
 *
 * Mirrors GET /api/cli/models and reshapes the response into pi-ai's
 * Model<Api> shape so pi's model picker / model resolver can consume
 * the catalog without knowing about the web backend.
 */

import type { Api, Model } from "@agentboster-cli/ai";

export interface RemoteModel {
	id: string;
	contextLimit?: number;
	maxOutputTokens?: number;
	temperature?: number;
}

export interface RemoteModelsResponse {
	ok: boolean;
	defaultModel: string | null;
	models: RemoteModel[];
}

/**
 * Pull the catalog. Returns null when auth is missing or the server
 * is unreachable — caller falls back to whatever pi has locally.
 */
export async function fetchRemoteModels(baseUrl: string, token: string): Promise<RemoteModelsResponse | null> {
	const root = baseUrl.replace(/\/$/, "");
	try {
		const response = await fetch(`${root}/api/cli/models`, {
			headers: {
				authorization: `Bearer ${token}`,
				cookie: `clawless-auth=${token}`,
			},
		});
		if (!response.ok) return null;
		return (await response.json()) as RemoteModelsResponse;
	} catch {
		return null;
	}
}

/**
 * Convert the remote catalog into pi-ai Model<Api> entries.
 *
 * All models are stamped with api="openai-responses" and provider=
 * "agentboster" — the adapter doesn't actually call any provider SDK,
 * it routes everything through /api/cli/chat, so these fields are
 * nominal. contextWindow / maxTokens come from the server; cost /
 * reasoning / input modalities fall back to permissive defaults.
 */
export function remoteModelsToPiModels(remote: RemoteModelsResponse): Model<Api>[] {
	return remote.models.map((m) => {
		const contextWindow = m.contextLimit ?? 128_000;
		const model: Model<Api> = {
			id: m.id,
			name: m.id,
			api: "openai-responses" as Api,
			provider: "agentboster" as never,
			baseUrl: "",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens: m.maxOutputTokens ?? 4096,
		};
		return model;
	});
}
