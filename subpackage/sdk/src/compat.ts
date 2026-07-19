/**
 * Compatibility helpers for extensions that need to resolve model API
 * keys across runtime versions.
 *
 * The current API is `ctx.modelRegistry.getApiKeyAndHeaders(model)`,
 * which returns a structured result with both the key and any required
 * headers. Older runtimes only exposed `getApiKey(model)`, returning a
 * bare string. Extensions that want to support both should call
 * {@link resolveModelApiKey} instead of touching the registry directly.
 */

// Minimal structural view of ExtensionContext.modelRegistry.
//
// We deliberately don't import the real ExtensionContext type here —
// the SDK must type-check without the runtime installed. The shape we
// touch is narrow enough that an inline structural interface is honest
// about what this helper actually depends on. The runtime ensures the
// real context is structurally compatible.
interface ModelRegistryLike {
  getApiKeyAndHeaders?: (
    m: unknown,
  ) => Promise<{ ok: true; apiKey?: string } | { ok: false; error: string }>;
  getApiKey?: (m: unknown) => Promise<string | undefined>;
}

interface ExtensionContextLike {
  modelRegistry: ModelRegistryLike;
}

/**
 * Resolve the API key for a model across runtime versions.
 *
 * Prefers `getApiKeyAndHeaders` (current API) and falls back to the
 * legacy `getApiKey` if the host runtime is older. Returns `undefined`
 * if neither is available or auth could not be resolved — callers
 * should surface a user-facing error in that case rather than throw.
 *
 * @example
 * ```ts
 * const apiKey = await resolveModelApiKey(ctx, model);
 * if (!apiKey) {
 *   ctx.ui.notify('API key not configured for this provider', 'error');
 *   return;
 * }
 * ```
 */
export async function resolveModelApiKey(
  ctx: ExtensionContextLike,
  model: unknown,
): Promise<string | undefined> {
  const registry = ctx.modelRegistry;

  if (typeof registry.getApiKeyAndHeaders === 'function') {
    const auth = await registry.getApiKeyAndHeaders(model);
    return auth.ok ? auth.apiKey : undefined;
  }

  if (typeof registry.getApiKey === 'function') {
    return await registry.getApiKey(model);
  }

  return undefined;
}
