/**
 * Compat — re-exports from index. The old compat was a provider
 * dispatch hub; this fork doesn't dispatch to any provider.
 *
 * The function signatures below mirror the upstream pi-ai contracts so
 * type-checking at call sites is accurate. The bodies all throw or
 * return inert defaults — at runtime the Agentboster adapter replaces
 * every code path that would reach them (see agent-session.ts:
 * `this.agent.streamFn` is set to the adapter, never `streamSimple`).
 */
import type {
	Api,
	AssistantMessage,
	Context,
	KnownProvider,
	Model,
	SimpleStreamOptions,
	ThinkingLevel,
} from "./index.ts";

export * from "./index.ts";

export function streamSimple(
	_model: Model<Api>,
	_context: Context,
	_options?: SimpleStreamOptions,
): never {
	throw new Error(
		"streamSimple is not available in this fork. Use the Agentboster adapter.",
	);
}

export function completeSimple(
	_model: Model<Api>,
	_context: Context,
	_options?: SimpleStreamOptions,
): never {
	throw new Error(
		"completeSimple is not available in this fork. Use the Agentboster adapter.",
	);
}

export function getModels(): Model<Api>[] {
	return [];
}

export function getProviders(): KnownProvider[] {
	return [];
}

export interface OAuthProviderStub {
	info: { id: string; name: string };
	id: string;
	login(): Promise<OAuthCredentials>;
	refresh(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
	modifyModels(models: unknown[]): void;
}

export function getOAuthProvider(_id: string): OAuthProviderStub | null {
	return null;
}

export function getOAuthProviders(): OAuthProviderStub[] {
	return [];
}

export function getOAuthApiKey(
	_id: string,
	_creds: unknown,
): Promise<{ apiKey: string; newCredentials: OAuthCredentials }> {
	return Promise.reject(new Error("OAuth not available in this fork."));
}

export function registerOAuthProvider(): void {}

export function resetOAuthProviders(): void {}

export function modelsAreEqual(
	a: Model<Api> | undefined,
	b: Model<Api> | undefined,
): boolean {
	return a?.id === b?.id;
}

export function validateToolArguments(
	_tool: unknown,
	call: unknown,
): unknown {
	return call;
}

export function cleanupSessionResources(_sessionId?: string): void {}

export function isContextOverflow(
	_message: AssistantMessage,
	_contextWindow: number,
): boolean {
	return false;
}

export function isRetryableAssistantError(
	_message: AssistantMessage,
): boolean {
	return false;
}

export function getSupportedThinkingLevels(
	_model: Model<Api>,
): ThinkingLevel[] {
	return ["low", "medium", "high"];
}

export function registerApiProvider(): void {}

export function resetApiProviders(): void {}

export function setBedrockProviderModule(): void {}

export function findEnvKeys(): Record<string, string> {
	return {};
}

export function getEnvApiKey(_provider: string): string | undefined {
	return undefined;
}

export type OAuthCredentials = Record<string, unknown> & {
	type?: string;
	accessToken?: string;
	expires?: number;
};
export type OAuthLoginCallbacks = Record<string, unknown>;
export type OAuthProviderId = string;
export type OAuthProviderInterface = Record<string, unknown>;
export type OAuthSelectPrompt = {
	id: string;
	label: string;
	options: { id: string; label: string }[];
};
export type OAuthSelectOption = { id: string; label: string };
export type OAuthDeviceCodeInfo = {
	userCode: string;
	verificationUri: string;
	expiresIn: number;
	interval: number;
};
