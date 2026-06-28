/**
 * Models — stub. The real pi-ai Models class dispatched to provider
 * SDKs. This fork routes through /api/cli/cli via @agentboster/adapter.
 */

export type { Api, Model } from "./types.ts";

export class ModelsError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "ModelsError";
		this.code = code;
	}
}
export type ModelsErrorCode = "no_provider" | "no_auth" | "no_model" | "unknown";

export interface AuthModel {
	id: string;
	provider: string;
	label?: string;
	api?: unknown;
}

export interface CreateProviderOptions {
	id: string;
	name?: string;
	baseURL?: string;
	apiKey?: string;
	authStrategy?: string;
}

export class Models {
	listProviders(): string[] {
		return [];
	}
	hasProvider(): boolean {
		return false;
	}
	registerProvider(): void {
		throw new ModelsError("no_provider", "Cannot register providers in this fork.");
	}
	stream(..._args: unknown[]): never {
		throw new ModelsError("no_provider", "Models.stream is stubbed; use the Agentboster adapter.");
	}
	streamSimple(..._args: unknown[]): never {
		throw new ModelsError("no_provider", "Models.streamSimple is stubbed; use the Agentboster adapter.");
	}
	complete(..._args: unknown[]): never {
		throw new ModelsError("no_provider", "Models.complete is stubbed; use the Agentboster adapter.");
	}
	completeSimple(..._args: unknown[]): never {
		throw new ModelsError("no_provider", "Models.completeSimple is stubbed; use the Agentboster adapter.");
	}
	getApiKeyAndHeaders(..._args: unknown[]): Promise<{ ok: false; error: string }> {
		return Promise.resolve({
			ok: false,
			error: "Models.getApiKeyAndHeaders is stubbed; auth lives on the web backend.",
		});
	}
}

export function clampThinkingLevel(..._args: unknown[]): unknown {
	return _args[0];
}
