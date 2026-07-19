import { z } from 'zod';

/**
 * MCP server configuration schema.
 *
 * Auth modes:
 *   - 'none'          : no authentication (public server)
 *   - 'static-headers': user-supplied headers (e.g. Authorization: Bearer <PAT>)
 *   - 'oauth'         : Authorization Code Flow + PKCE; tokens are stored
 *                       separately in the Vault (see lib/mcp/oauth-store.ts),
 *                       NEVER in this config. The fields below carry only
 *                       the public OAuth client metadata required to start
 *                       the flow.
 *
 * The 'oauthVaultKey' field is populated automatically by the OAuth callback
 * route after a successful authorization — it's the Vault key under which
 * the encrypted token bundle lives. We keep it in config (rather than
 * deriving it from the server name) so that re-keying or rotating a
 * credential doesn't require migrating serverName-keyed Vault entries.
 */
export const mcpOAuthConfigSchema = z.object({
  clientId: z.string().min(1),
  /** Authorize endpoint, e.g. https://github.com/login/oauth/authorize */
  authorizeUrl: z.url(),
  /** Token endpoint, e.g. https://github.com/login/oauth/access_token */
  tokenUrl: z.url(),
  /**
   * Optional server-supplied scopes (space-separated per RFC 6749).
   */
  scope: z.string().optional(),
  /**
   * Optional resource parameter (RFC 8707) — required by some newer MCP
   * servers (e.g. GitHub's hosted MCP). Sent both on authorize and token
   * exchange.
   */
  resource: z.string().optional(),
  /**
   * Optional RFC 7009 revocation endpoint. When provided, the revoke
   * route will POST the refresh_token (and access_token, if present)
   * here before deleting the local Vault entry. When absent, only the
   * local copy is deleted — the provider-side token expires on its own.
   */
  revokeUrl: z.url().optional(),
  /**
   * Vault key holding the encrypted OAuth token bundle. Set by the
   * callback route; presence here means "OAuth completed at least once".
   */
  vaultKey: z.string().optional(),
});

export const mcpRemoteServerConfigSchema = z
  .object({
    type: z.enum(['http', 'sse']).default('http'),
    url: z.url('MCP server URL must be a valid URL'),
    headers: z.record(z.string(), z.string()).optional(),
    auth: z
      .object({
        mode: z.enum(['none', 'static-headers', 'oauth']).default('none'),
        oauth: mcpOAuthConfigSchema.optional(),
      })
      .default({ mode: 'none' }),
  })
  .superRefine((server, ctx) => {
    if (server.auth?.mode === 'oauth' && !server.auth.oauth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['auth', 'oauth'],
        message: 'OAuth config is required when auth.mode is "oauth"',
      });
    }
  });

export const builtinMcpServerConfigSchema = z.object({
  enabled: z.boolean().default(true),
});

export type McpOAuthConfig = z.infer<typeof mcpOAuthConfigSchema>;
export type MCPRemoteServerConfig = z.infer<typeof mcpRemoteServerConfigSchema>;
export type BuiltinMcpServerConfig = z.infer<
  typeof builtinMcpServerConfigSchema
>;

/**
 * MCP remote server map configuration schema.
 *
 * The record key (server name) is constrained to the Vault key charset
 * (`[a-zA-Z0-9_.:-]`, 1-64 chars). This matches `buildOAuthVaultKey` in
 * lib/mcp/oauth-store.ts — without it, a server name like `a/b` would
 * be silently rewritten to `a-b` and collide with a server literally
 * named `a-b`, crossing credential boundaries.
 */
export const mcpRemotesServersConfigSchema = z
  .record(
    z.string().regex(/^[a-zA-Z0-9_.:-]{1,64}$/),
    mcpRemoteServerConfigSchema,
  )
  .default({});

export const builtinMcpServersConfigSchema = z
  .record(z.string(), builtinMcpServerConfigSchema)
  .default({});

export type MCPRemoteServersConfig = z.infer<
  typeof mcpRemotesServersConfigSchema
>;

export type BuiltinMcpServersConfig = z.infer<
  typeof builtinMcpServersConfigSchema
>;

export const imageAnalyzeInputSchema = z.object({
  image_path: z.string().min(1),
  prompt: z.string().optional(),
  max_tokens: z.number().int().min(1).max(4096).optional().default(1024),
});

export const imageAnalyzeOutputSchema = z.object({
  description: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});

export type ImageAnalyzeInput = z.infer<typeof imageAnalyzeInputSchema>;
export type ImageAnalyzeOutput = z.infer<typeof imageAnalyzeOutputSchema>;
