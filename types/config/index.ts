import { z } from 'zod';

import { agentdConfigSchema } from './agentd';
import { agentConfigSchema } from './agents';
import { aiConfigSchema } from './ai';
import { autonomyConfigSchema } from './autonomy';
import { chatConfigSchema } from './chat';
import { channelsConfigSchema } from './channels';
import { experimentsConfigSchema } from './experiments';
import { languageConfigSchema } from './language';
import { mcpRemotesServersConfigSchema } from './mcp';
import { sandboxConfigSchema } from './sandbox';
import { securityConfigSchema } from './security';
import { buildInToolConfigSchema } from './tools';
import { ttsConfigSchema } from './tts';

/**
 * Full application configuration schema.
 */
export * from './channels';
export * from './experiments';
export * from './language';
export const appConfigSchema = z.object({
  /** AI models and provider settings. */
  models: aiConfigSchema.optional(),

  /** Agent/Bot configuration. */
  agents: agentConfigSchema.optional(),

  /**
   * Third-party CLI extensions (AionHub-style manifest list, batch #11).
   * Each entry lets the daemon spawn an external coding-agent CLI
   * (claude-code, codex, opencode) as a subprocess node. Built-in defaults
   * are merged with these entries — see lib/extra/extensions/manifest.ts.
   */
  extensions: z
    .array(
      z.object({
        name: z.string(),
        label: z.string().optional(),
        cliCommand: z.string(),
        defaultCliPath: z.string().optional(),
        args: z.array(z.string()).optional(),
        authEnv: z.array(z.string()).optional(),
        authMode: z.enum(['env', 'oauth', 'terminal']).optional(),
        description: z.string().optional(),
      }),
    )
    .optional(),

  /** Chat UI and reply behavior. */
  chat: chatConfigSchema.optional(),

  /** Interface and bot language settings. */
  language: languageConfigSchema.optional(),

  /** Communication channel configuration (Telegram, Slack, Teams, Google Chat, etc.). */
  channels: channelsConfigSchema.optional(),

  /** Agent autonomy permissions and limits. */
  autonomy: autonomyConfigSchema.optional(),

  /** Web-side security scoring configuration. */
  security: securityConfigSchema.optional(),

  /** Sandbox configuration. */
  sandbox: sandboxConfigSchema.optional(),

  /** Built-in tool configuration. */
  tools: buildInToolConfigSchema.optional(),

  /** MCP remote server configuration. */
  mcp: mcpRemotesServersConfigSchema.optional(),

  /** Agent Daemon configuration. */
  agentd: agentdConfigSchema.optional(),

  /** Text-to-Speech configuration (Web auto-play + IM voice replies). */
  tts: ttsConfigSchema.optional(),

  /** Experimental features (off by default). */
  experiments: experimentsConfigSchema.optional(),
});

/**
 * TypeScript type inferred from the application config schema.
 */
export type AppConfig = z.infer<typeof appConfigSchema>;

/**
 * Config storage key constant.
 */
export const CONFIG_KEY = 'config' as const;
