/**
 * Minimal ModelRegistry for the Agentboster fork.
 *
 * The full pi ModelRegistry managed provider SDKs, OAuth login,
 * models.json, and per-provider auth. In this fork the catalog comes
 * from /api/cli/models via setRemoteModels(), and auth is a bearer
 * token handled by the adapter. All provider/OAuth/model registration
 * logic is gone.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { AuthStorage } from "./auth-storage.ts";

export type { Model };

export type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey: string;
			headers?: Record<string, string>;
			env?: Record<string, string>;
	  }
	| {
			ok: false;
			error: string;
	  };

export interface ProviderConfigInput {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
}

export class ModelRegistry {
	readonly authStorage: AuthStorage;
	private models: Model<Api>[] = [];
	private loadError: string | undefined;
	private remoteModelsLocked = false;
	private runtimeApiKeys = new Map<string, string>();

	constructor(authStorage: AuthStorage) {
		this.authStorage = authStorage;
	}

	static create(authStorage?: AuthStorage, _modelsPath?: string): ModelRegistry {
		return new ModelRegistry(authStorage ?? AuthStorage.create());
	}

	static inMemory(authStorage?: AuthStorage, _modelsPath?: string): ModelRegistry {
		return new ModelRegistry(authStorage ?? AuthStorage.create());
	}

	getAll(): Model<Api>[] {
		return this.models;
	}

	getAvailable(): Model<Api>[] {
		return this.models;
	}

	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.models.find((m) => m.provider === provider && m.id === modelId);
	}

	hasConfiguredAuth(_model: Model<Api>): boolean {
		return true;
	}

	getError(): string | undefined {
		return this.loadError;
	}

	refresh(): void {
		if (this.remoteModelsLocked) return;
	}

	setRemoteModels(models: Model<Api>[]): void {
		this.models = models;
		this.remoteModelsLocked = true;
		this.authStorage.set("agentboster", {
			type: "api_key",
			key: "agentboster-adapter",
		} as never);
	}

	async getApiKeyAndHeaders(_model: Model<Api>): Promise<ResolvedRequestAuth> {
		return {
			ok: true,
			apiKey: "agentboster-adapter",
		};
	}

	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		return this.runtimeApiKeys.get(provider);
	}

	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeApiKeys.set(provider, apiKey);
	}

	getProviderDisplayName(provider: string): string {
		return provider;
	}

	getProviderAuthStatus(_provider: string): { type: string } {
		return { type: "api_key" };
	}

	isUsingOAuth(_model: Model<Api>): boolean {
		return false;
	}

	registerProvider(_providerName: string, _config: ProviderConfigInput): void {}

	unregisterProvider(_providerName: string): void {}
}
