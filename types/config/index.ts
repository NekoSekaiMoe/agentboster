import { z } from 'zod';

import { agentConfigSchema } from './agents';
import { aiConfigSchema } from './ai';
import { autonomyConfigSchema } from './autonomy';
import { channelsConfigSchema } from './channels';
import { mcpRemotesServersConfigSchema } from './mcp';
import { sandboxConfigSchema } from './sandbox';
import { buildInToolConfigSchema } from './tools';

/**
 * Full application configuration schema.
 */
export * from './channels';
export const appConfigSchema = z.object({
  /** AI models and provider settings. */
  models: aiConfigSchema.optional(),

  /** Agent/Bot configuration. */
  agents: agentConfigSchema.optional(),

  /** Communication channel configuration (Telegram, Slack, Teams, Google Chat, etc.). */
  channels: channelsConfigSchema.optional(),

  /** Agent autonomy permissions and limits. */
  autonomy: autonomyConfigSchema.optional(),

  /** Sandbox configuration. */
  sandbox: sandboxConfigSchema.optional(),

  /** Built-in tool configuration. */
  tools: buildInToolConfigSchema.optional(),

  /** MCP remote server configuration. */
  mcp: mcpRemotesServersConfigSchema.optional(),
});

/**
 * TypeScript type inferred from the application config schema.
 */
export type AppConfig = z.infer<typeof appConfigSchema>;

/**
 * Config storage key constant.
 */
export const CONFIG_KEY = 'config' as const;
