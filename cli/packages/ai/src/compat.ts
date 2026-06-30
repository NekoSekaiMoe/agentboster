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

export function streamSimple(_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions): never {
	throw new Error("streamSimple is not available in this fork. Use the Agentboster adapter.");
}

export function completeSimple(_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions): never {
	throw new Error("completeSimple is not available in this fork. Use the Agentboster adapter.");
}

export function getProviders(): KnownProvider[] {
	return [];
}

export function modelsAreEqual(a: Model<Api> | undefined, b: Model<Api> | undefined): boolean {
	return a?.id === b?.id;
}

export function validateToolArguments(_tool: unknown, call: unknown): unknown {
	return call;
}

export function cleanupSessionResources(_sessionId?: string): void {}

export function isContextOverflow(_message: AssistantMessage, _contextWindow: number): boolean {
	return false;
}

export function isRetryableAssistantError(_message: AssistantMessage): boolean {
	return false;
}

export function getSupportedThinkingLevels(_model: Model<Api>): ThinkingLevel[] {
	return ["low", "medium", "high"];
}

export function resetApiProviders(): void {}

export type OAuthCredentials = Record<string, unknown> & {
	type?: string;
	accessToken?: string;
	expires?: number;
};
export type OAuthLoginCallbacks = Record<string, unknown>;
