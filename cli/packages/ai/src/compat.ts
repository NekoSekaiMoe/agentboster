/**
 * Compat — re-exports from index. The old compat was a provider
 * dispatch hub; this fork doesn't dispatch to any provider.
 */
export * from "./index.ts";
export function streamSimple(..._args: unknown[]): never {
	throw new Error("streamSimple is not available in this fork. Use the Agentboster adapter.");
}
export function completeSimple(..._args: unknown[]): never {
	throw new Error("completeSimple is not available in this fork. Use the Agentboster adapter.");
}
export function getModels(..._args: unknown[]): unknown[] {
	return [];
}
export function getProviders(..._args: unknown[]): string[] {
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
export function getOAuthApiKey(_id: string, _creds: unknown): Promise<{ apiKey: string; newCredentials: OAuthCredentials }> {
	return Promise.reject(new Error("OAuth not available in this fork."));
}
export function registerOAuthProvider(): void {}
export function resetOAuthProviders(): void {}
export function modelsAreEqual(a: unknown, b: unknown): boolean {
	return a === b;
}
export function validateToolArguments(_tool: unknown, _call: unknown): unknown {
	return _call;
}
export function cleanupSessionResources(_sessionId?: unknown): void {}
export function isContextOverflow(..._args: unknown[]): boolean {
	return false;
}
export function isRetryableAssistantError(..._args: unknown[]): boolean {
	return false;
}
export function getSupportedThinkingLevels(..._args: unknown[]): unknown[] {
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
export type OAuthCredentials = Record<string, unknown> & { type?: string; accessToken?: string; expires?: number };
export type OAuthLoginCallbacks = Record<string, unknown>;
export type OAuthProviderId = string;
export type OAuthProviderInterface = Record<string, unknown>;
export type OAuthSelectPrompt = { id: string; label: string; options: { id: string; label: string }[] };
export type OAuthSelectOption = { id: string; label: string };
export type OAuthDeviceCodeInfo = { userCode: string; verificationUri: string; expiresIn: number; interval: number };
